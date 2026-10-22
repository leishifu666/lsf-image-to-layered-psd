#!/usr/bin/env python3
"""Reusable custom-provider image generation. No SDK, no paid automatic retries.

Requires Python 3.10+ and Pillow for inspecting actual image pixels and Alpha.
One independent job per element; all prepared jobs run concurrently by default.
"""
import argparse
import base64
import concurrent.futures
import datetime
import email.utils
import io
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


class ProviderError(Exception):
    def __init__(self, message, *, status="failed", http_status=None, retry_after=None):
        super().__init__(message)
        self.status, self.http_status, self.retry_after = status, http_status, retry_after


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_json(file):
    return json.loads(Path(file).read_text(encoding="utf-8-sig"))


def require_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ("https", "http") or not p.hostname:
        raise ValueError("API/download URL must use HTTPS or HTTP")
    if p.username or p.password or p.fragment:
        raise ValueError("URL must not contain credentials or fragments")
    return p


def positive(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def load_config(file):
    config = read_json(file)
    if not isinstance(config, dict):
        raise ValueError("Configuration must be an object")
    if any(k in config for k in ("api_key", "key", "token", "headers")):
        raise ValueError("Use api_key_env or api_key_file; do not embed keys or headers")
    if config.get("protocol") not in ("openai-images", "gemini-generate-content"):
        raise ValueError("Unsupported protocol; add an adapter using provider documentation")
    url = config.get("base_url", "")
    parsed = require_url(url)
    if parsed.query:
        raise ValueError("base_url must not include a query string; use header authentication")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("Credential-bearing remote API requests require HTTPS")
    if not isinstance(config.get("model"), str) or not config["model"].strip():
        raise ValueError("Set the provider's actual model name")
    if config.get("api_key_env") and config.get("api_key_file"):
        raise ValueError("Choose one key source")
    if config.get("api_key_file"):
        key_file = Path(config["api_key_file"])
        if not key_file.is_absolute():
            key_file = Path(file).resolve().parent / key_file
        key = key_file.read_text(encoding="utf-8-sig").strip()
    else:
        env = config.get("api_key_env", "LSF_IMAGE_API_KEY")
        if not isinstance(env, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env):
            raise ValueError("Invalid key environment variable name")
        key = os.environ.get(env, "").strip()
    if not key or "\r" in key or "\n" in key:
        raise ValueError("API key source is missing or invalid")
    config["base_url"] = url.rstrip("/")
    config["timeout_seconds"] = positive(config.get("timeout_seconds", 180), "timeout_seconds")
    config["max_response_bytes"] = int(positive(config.get("max_response_bytes", 100 * 1024 * 1024), "max_response_bytes"))
    if not isinstance(config.get("parameters", {}), dict):
        raise ValueError("parameters must be an object")
    if not isinstance(config.get("generation_config", {}), dict):
        raise ValueError("generation_config must be an object")
    return config, key


def endpoint(config, name, default):
    suffix = config.get(name, default)
    if not isinstance(suffix, str) or "?" in suffix or "#" in suffix or "://" in suffix:
        raise ValueError("Endpoint paths must be relative to base_url without query strings")
    if ".." in suffix.split("/") or suffix.startswith("//"):
        raise ValueError("Invalid endpoint path")
    return config["base_url"] + "/" + suffix.lstrip("/")


def auth_headers(config, key):
    is_google = config["protocol"] == "gemini-generate-content"
    header = config.get("auth_header", "x-goog-api-key" if is_google else "Authorization")
    prefix = config.get("auth_prefix", "" if is_google else "Bearer ")
    if not isinstance(header, str) or not re.fullmatch(r"[A-Za-z0-9-]+", header):
        raise ValueError("Invalid authentication header")
    if header.lower() in ("host", "content-type", "content-length", "cookie"):
        raise ValueError("Invalid authentication header")
    if not isinstance(prefix, str) or "\r" in prefix or "\n" in prefix:
        raise ValueError("Invalid authentication prefix")
    return {header: prefix + key, "Accept": "application/json"}


def fetch(url, *, body=None, headers=None, timeout=180, max_bytes=100 * 1024 * 1024):
    require_url(url)
    request = urllib.request.Request(url, data=body, headers=headers or {}, method="POST" if body is not None else "GET")
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ProviderError("Provider response exceeds configured byte limit; no automatic retry")
            return data
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            message = "HTTP 429: rate limited; only retry rejected jobs after the provider's wait"
        elif exc.code in (401, 403):
            message = f"HTTP {exc.code}: check API key, model and provider access"
        elif 300 <= exc.code < 400:
            message = f"HTTP {exc.code}: redirect blocked; configure the final API/download address"
        else:
            message = f"HTTP {exc.code}: provider rejected or could not complete the request"
        wait = exc.headers.get("Retry-After", "")
        retry_after = None
        if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", wait):
            retry_after = float(wait)
        elif wait:
            try:
                date = email.utils.parsedate_to_datetime(wait)
                if date.tzinfo is not None:
                    retry_after = max(0, (date - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
            except (ValueError, TypeError, OverflowError):
                pass
        exc.close()
        raise ProviderError(message, status="unknown" if exc.code >= 500 else "failed", http_status=exc.code,
                            retry_after=retry_after) from None
    except (TimeoutError, socket.timeout, urllib.error.URLError):
        raise ProviderError("Network failure or timeout; generation outcome is unknown; check provider history before retrying", status="unknown") from None


def inspect_image(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        image.load()
        fmt, width, height, mode = image.format, image.width, image.height, image.mode
        has_alpha = "A" in image.getbands() or "transparency" in image.info
        histogram = image.convert("RGBA").getchannel("A").histogram() if has_alpha else None
        nonzero = [i for i, count in enumerate(histogram or []) if count]
        return {"format": fmt, "width": width, "height": height, "color_mode": mode, "has_alpha_channel": has_alpha,
                "alpha_range": [min(nonzero), max(nonzero)] if nonzero else None,
                "transparent_pixels": histogram[0] if histogram else 0,
                "semi_transparent_pixels": sum(histogram[1:255]) if histogram else 0}


def b64_image(value):
    if not isinstance(value, str):
        raise ProviderError("Provider image data is not base64 text")
    if value.startswith("data:"):
        if not re.match(r"^data:image/[^;,]+;base64,", value):
            raise ProviderError("Unsupported image data URI")
        value = value.split(",", 1)[1]
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ProviderError("Provider returned invalid base64 image data") from None


def prepare_job(job, jobs_dir, output_dir):
    if not isinstance(job, dict):
        raise ValueError("Each job must be an object")
    id_ = job.get("id", "")
    if not isinstance(id_, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", id_):
        raise ValueError("Element ID must be a safe, unique filename")
    if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", id_, re.I):
        raise ValueError("Reserved filename")
    if list(output_dir.glob(id_ + ".*")):
        raise ValueError("Element output already exists; use a new ID or reuse the saved result")
    if not isinstance(job.get("prompt"), str) or not job["prompt"].strip():
        raise ValueError("Each element needs a non-empty prompt")
    if "transparent" in job and not isinstance(job["transparent"], bool):
        raise ValueError("transparent must be true or false")
    expected = job.get("expected_size")
    if expected is not None and (not isinstance(expected, list) or len(expected) != 2 or
            any(isinstance(v, bool) or not isinstance(v, int) or v <= 0 for v in expected)):
        raise ValueError("expected_size must contain two positive pixel dimensions")
    parameters = job.get("parameters", {})
    if not isinstance(parameters, dict):
        raise ValueError("Job parameters must be an object")
    if not isinstance(job.get("generation_config", {}), dict):
        raise ValueError("Job generation_config must be an object")
    image_paths = job.get("images", [])
    if not isinstance(image_paths, list):
        raise ValueError("images must be a list of local paths")
    images = []
    for p in image_paths:
        if not isinstance(p, str):
            raise ValueError("Reference path must be a string")
        file = Path(p)
        if not file.is_absolute():
            file = jobs_dir / file
        data = file.read_bytes()
        if len(data) > 50 * 1024 * 1024:
            raise ValueError("Reference image exceeds 50 MB; check provider limits")
        details = inspect_image(data)
        mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}.get(details["format"])
        if not mime:
            raise ValueError("Reference format must be PNG, JPEG or WebP")
        images.append((mime, data))
    return {**job, "_images": images}


def multipart(fields, images, image_field):
    boundary = "lsf-" + uuid.uuid4().hex
    chunks = []
    for name, value in fields.items():
        if not re.fullmatch(r"[A-Za-z0-9_]+", name):
            raise ValueError("Invalid multipart parameter name")
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        chunks.extend([(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n").encode(), text.encode("utf-8"), b"\r\n"])
    if image_field not in ("image", "image[]"):
        raise ValueError("image_field must be image or image[]")
    for i, (mime, data) in enumerate(images):
        suffix = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[mime]
        chunks.extend([(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{image_field}\"; filename=\"reference-{i}.{suffix}\"\r\nContent-Type: {mime}\r\n\r\n").encode(), data, b"\r\n"])
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


def generate(config, key, job):
    headers = auth_headers(config, key)
    if config["protocol"] == "openai-images":
        parameters = {**config.get("parameters", {}), **job.get("parameters", {})}
        if any(k in parameters for k in ("model", "prompt", "image", "images", "n", "stream")):
            raise ValueError("Do not override model/prompt/images/n/stream inside parameters")
        if "transparent" in job and config.get("send_background_parameter", True):
            parameters["background"] = "transparent" if job["transparent"] else "opaque"
        fields = {"model": config["model"], "prompt": job["prompt"], "n": 1, **parameters}
        if job["_images"]:
            url = endpoint(config, "edit_path", "images/edits")
            body, headers["Content-Type"] = multipart(fields, job["_images"], config.get("image_field", "image[]"))
        else:
            url = endpoint(config, "generation_path", "images/generations")
            body = json.dumps(fields, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
    else:
        model = urllib.parse.quote(config["model"].removeprefix("models/"), safe="-._")
        url = endpoint(config, "generate_content_path", "models/{model}:generateContent").replace("{model}", model)
        parts = [{"text": job["prompt"]}] + [{"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode("ascii")}} for mime, data in job["_images"]]
        gc = {"responseModalities": ["TEXT", "IMAGE"], **config.get("generation_config", {}), **job.get("generation_config", {})}
        body = json.dumps({"contents": [{"role": "user", "parts": parts}], "generationConfig": gc}, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    raw = fetch(url, body=body, headers=headers, timeout=config["timeout_seconds"], max_bytes=config["max_response_bytes"])
    try:
        response = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ProviderError("Provider did not return JSON; request outcome is unknown", status="unknown") from None
    if config["protocol"] == "openai-images":
        images = response.get("data", [])
        if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
            raise ProviderError("Expected exactly one image in data[]; no automatic retry")
        item = images[0]
        if item.get("b64_json"):
            data = b64_image(item["b64_json"])
        elif item.get("url"):
            # Output URLs never receive the API key, even on the same host.
            data = fetch(item["url"], timeout=config["timeout_seconds"], max_bytes=config["max_response_bytes"])
        else:
            raise ProviderError("No image data or image URL returned")
    else:
        images = []
        for candidate in response.get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                if part.get("thought"):
                    continue
                value = part.get("inlineData", part.get("inline_data"))
                if value and value.get("data"):
                    images.append(value["data"])
        if len(images) != 1:
            raise ProviderError("Expected one final inlineData image; no automatic retry")
        data = b64_image(images[0])
    if len(data) > config["max_response_bytes"]:
        raise ProviderError("Decoded image exceeds configured byte limit")
    return data


def execute_job(config, key, raw_job, jobs_dir, output_dir):
    started = time.monotonic()
    result = {"id": raw_job.get("id") if isinstance(raw_job, dict) else None, "status": "failed"}
    phase = "preflight"
    data, ext = None, None
    try:
        job = prepare_job(raw_job, jobs_dir, output_dir)
        phase = "request"
        data = generate(config, key, job)
        phase = "validate"
        info = inspect_image(data)
        ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}.get(info["format"])
        if not ext:
            raise ProviderError("Unsupported returned image format")
        file = output_dir / (job["id"] + "." + ext)
        phase = "save"
        with file.open("xb") as stream:
            stream.write(data)
        result.update({"file": str(file), "pixels": [info["width"], info["height"]], **info, "byte_count": len(data), "resized": False})
        reasons = []
        expected = job.get("expected_size")
        if expected is None and config["protocol"] == "openai-images":
            size = {**config.get("parameters", {}), **job.get("parameters", {})}.get("size", "")
            if isinstance(size, str) and re.fullmatch(r"[0-9]+x[0-9]+", size):
                expected = [int(n) for n in size.split("x")]
        result["expected_size"] = expected
        result["size_matches_request"] = result["pixels"] == expected if expected is not None else None
        if expected is not None and result["pixels"] != expected:
            reasons.append("Actual pixel dimensions do not match the request")
        if job.get("transparent") and (not info["has_alpha_channel"] or not info["transparent_pixels"] or info["alpha_range"][1] == 0):
            reasons.append("Foreground does not have usable real transparency")
        if job.get("require_png", True) and info["format"] != "PNG":
            reasons.append("Provider returned a non-PNG image; retain it and verify a lossless conversion")
        result.update({"status": "needs_review" if reasons else "succeeded", "review_reasons": reasons})
    except Exception as exc:
        result["phase"] = phase
        result["status"] = getattr(exc, "status", "unknown" if phase in ("request", "validate") else "failed")
        # Never emit raw HTTP response bodies, prompts, URLs, headers or credentials.
        known = isinstance(exc, (ProviderError, ValueError, FileNotFoundError, FileExistsError))
        message = str(exc) if known else type(exc).__name__ + ": check provider/output configuration"
        message = message.replace(key, "[REDACTED]")
        result["error"] = re.sub(r"https?://\S+", "[URL]", message)[:320]
        if isinstance(exc, ProviderError):
            result.update({"http_status": exc.http_status, "retry_after_seconds": exc.retry_after})
        if phase == "save" and data is not None and ext is not None:
            # Keep the already-generated asset when its final destination cannot be written.
            try:
                recovery_dir = jobs_dir / "api-recovery"
                recovery_dir.mkdir(parents=True, exist_ok=True)
                recovery = recovery_dir / (job["id"] + "-" + uuid.uuid4().hex + "." + ext)
                with recovery.open("xb") as stream:
                    stream.write(data)
                result["recovery_file"] = str(recovery.resolve())
                result["error"] = "Generated image retained in recovery_file; restore saving without regenerating"
            except OSError:
                result["error"] = "Generated image could not be saved or recovered; check provider history before any generation retry"
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    return result


def run(config_file, jobs_file, output_dir, *, concurrency=None, check=False, emit=None):
    from PIL import Image  # Verify dependency before any paid request.
    config, key = load_config(config_file)
    jobs = read_json(jobs_file)
    if not isinstance(jobs, list):
        raise ValueError("Jobs file must be an array")
    ids = [j.get("id") if isinstance(j, dict) else None for j in jobs]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("Every job must have a unique, non-empty element ID")
    directory = Path(output_dir).resolve()
    jobs_dir = Path(jobs_file).resolve().parent
    if concurrency is not None and (isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency < 1):
        raise ValueError("concurrency must be a positive integer or omitted for all")
    if check:
        for job in jobs:
            prepare_job(job, jobs_dir, directory)
            auth_headers(config, key)
        return {"status": "checked", "protocol": config["protocol"], "model": config["model"], "jobs": len(jobs), "network_requests": 0, "concurrency": concurrency or "all"}
    directory.mkdir(parents=True, exist_ok=True)
    workers = min(concurrency, len(jobs)) if concurrency else len(jobs)
    results = [None] * len(jobs)
    if jobs:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(execute_job, config, key, j, jobs_dir, directory): i for i, j in enumerate(jobs)}
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                results[futures[future]] = result
                if emit:
                    try:
                        emit(result)
                    except Exception as exc:
                        result["progress_output_error"] = type(exc).__name__
    summary = {"protocol": config["protocol"], "model": config["model"], "requested_concurrency": concurrency or "all", "results": results,
               "succeeded": sum(r["status"] == "succeeded" for r in results), "needs_review": sum(r["status"] == "needs_review" for r in results),
               "failed_or_unknown": sum(r["status"] in ("failed", "unknown") for r in results), "automatic_retries": 0}
    # One writer saves the manifest after all jobs complete; existing manifests are kept.
    manifest = directory / ("api-results-" + uuid.uuid4().hex[:12] + ".json")
    with manifest.open("x", encoding="utf-8") as stream:
        json.dump(summary, stream, ensure_ascii=False, indent=2)
    summary["manifest"] = str(manifest)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--concurrency", type=int, help="Omit to submit all prepared elements concurrently")
    parser.add_argument("--check", action="store_true", help="Local preflight only; no network requests")
    args = parser.parse_args()
    try:
        result = run(args.config, args.jobs, args.output_dir, concurrency=args.concurrency, check=args.check,
                     emit=lambda value: print(json.dumps(value, ensure_ascii=False), flush=True))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if args.check or result["succeeded"] == len(result["results"]) else 2
    except Exception as exc:
        # Configuration errors may contain a supplied credential/path; emit only the type.
        print(json.dumps({"status": "failed", "error_type": type(exc).__name__, "error": "Local preflight failed; check key source, protocol, model, input paths and Pillow"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
