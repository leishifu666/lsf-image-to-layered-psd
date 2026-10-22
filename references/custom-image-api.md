# 自定义 API 生图 · PS

用户选择 API 后读取。本包支持内置工具或 API 两种生图入口；切换入口不改变元素保真、坐标、图层、字体和验收标准。API 服务和运行 AI 客户端各自的权限与费用仍适用。

## 配置

核实用户指定的 API 基础地址、协议、实际模型 ID、密钥来源和必要参数。只接入指定服务，不擅自切供应商。地址是否包含 /v1 以服务商为准，不盲目追加。

密钥从 api_key_env 对应环境变量或用户明确指定的 api_key_file 读取，不把实际值写进 skill、普通 JSON、任务清单、命令参数、提示词或日志。凭据文件应存私有位置，不进分发包。HTTPS 用于远程鉴权，HTTP 仅允许本机模拟；请求重定向不会携带密钥跳转，图片下载不附带 API 鉴权。

已选择 API 且要求处理本次图片，属于已授权元素任务，不为每个元素重复确认。只讨论/维护技能或仅提供配置，不启动生图、收费测速或自动重试。

## 支持的同步接口契约

- openai-images：无参考图用 images/generations 的 JSON；有参考图用 images/edits 的 multipart。读取一张 data[].b64_json 或 data[].url。参考字段 image[] 可按服务要求改为 image；可用 auth_header/auth_prefix 配置鉴权名称和前缀，不直接塞含密钥的 headers。
- gemini-generate-content：调用 models/{model}:generateContent，参考图为 inlineData；读取最终的 candidates[].content.parts[].inlineData（兼容 inline_data），忽略 thought 图片。默认 x-goog-api-key。

支持这些结构不代表任意服务都兼容。异步轮询、Chat Completions、Interactions 或其他协议需要按实际官方文档增加适配，不能只换 URL。generation_path、edit_path、generate_content_path 仅调整同一基础地址下的相对路径。

Python 3.10+，依赖 Pillow；HTTP 使用标准库，不依赖模型 SDK。安装 python -m pip install -r requirements.txt，或让客户端在本次任务的独立运行环境准备依赖。

## 示例（先替换服务信息，不含密钥）

示例地址使用无服务的保留域名，不会作为可用供应商。实际模型、尺寸与透明支持必须先核实。

```json
{
  "protocol": "openai-images",
  "base_url": "https://api.example.invalid/v1",
  "model": "REPLACE_WITH_SUPPORTED_MODEL_ID",
  "api_key_env": "LSF_IMAGE_API_KEY",
  "timeout_seconds": 180,
  "parameters": {}
}
```

```json
{
  "protocol": "gemini-generate-content",
  "base_url": "https://api.example.invalid/v1",
  "model": "REPLACE_WITH_SUPPORTED_MODEL_ID",
  "api_key_env": "LSF_IMAGE_API_KEY",
  "generation_config": {
    "responseModalities": [
      "TEXT",
      "IMAGE"
    ]
  }
}
```

OpenAI 契约中 transparent 元素会按 true/false 发送 background=transparent/opaque；服务明确不支持时可设 send_background_parameter=false，但仍须检查实际 Alpha，不能实色冒充透明。generation_config 按用户服务当前文档填写，不猜测档位字段。

## 元素任务

任务是 JSON 数组，一项只对应一个目标元素；images 路径相对任务文件目录或使用明确的绝对路径。稳定 ID 用于关联原图坐标与层序，不能按完成顺序排序。

```json
[
  {
    "id": "R00",
    "prompt": "移除前景后的完整背景，保持原图构图和纹理",
    "images": [
      "reference.png"
    ],
    "transparent": false
  },
  {
    "id": "R01",
    "prompt": "只重建原图的指定主体，保持造型材质并补全遮挡，真实透明背景",
    "images": [
      "reference.png"
    ],
    "transparent": true,
    "expected_size": [
      1024,
      1024
    ]
  }
]
```

expected_size 是本次 API 期望返回的原始像素，示例 [1024,1024] 必须按实际请求修改，不是最终 PSD 尺寸。最终尺寸按 [output-resolution.md](output-resolution.md) 独立落实。

```text
python scripts/image_api.py --config work/image-api.json --jobs work/elements.json --output-dir outputs/elements --check
python scripts/image_api.py --config work/image-api.json --jobs work/elements.json --output-dir outputs/elements
```

--check 只做本地检查，不访问网络；正式运行默认全量提交独立元素。只有服务或用户已明确要求限制时才加 --concurrency N。任务 JSON 不保存密钥。

## 验收与恢复

脚本保留原始图片字节，记录真实宽高、格式、Alpha 范围及透明/半透明像素数，不后期放大。尺寸不符、前景无可用 Alpha 或格式不符合 PNG 要求时为 needs_review；PNG 扩展名本身不证明真实透明。

这些文件检查不证明造型、文字、材质和遮挡补全正确，仍需逐元素视觉验收。合格素材仅像素不足时可以在组装阶段等比输出目标尺寸，注明放大与非原生细节，不改写原始生成记录。Alpha 或内容失败不能靠放大变成通过。

脚本不自动重试付费生成。401/403 核对权限，400 核对契约/模型/参数；429 按 retry_after_seconds 和明确失败状态处理。超时、5xx 或结果未知时先核对服务产物，避免重复收费。生成成功但保存失败时尝试保留在 api-recovery，存在 recovery_file 时先恢复保存。

当前实现保存的是受支持响应结构，不包含供应商密钥、真实配置、临时签名图片 URL 或原始响应日志。官方契约参考：[OpenAI 图片生成](https://developers.openai.com/api/docs/guides/image-generation)、[图片编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)、[Gemini 图片生成](https://ai.google.dev/gemini-api/docs/image-generation)。更换服务或模型时重新核实。
