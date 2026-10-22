# Photoshop 原生可编辑文字

PS 模式处理普通文字时读取；原生文字编辑是本模式的组成部分。先执行 [font-verification.md](font-verification.md)，再重建。目标是 PSD 内存在文字内容、正确字体、字号、颜色、位置及排版数据，能用文字工具修改；字体保真与编辑能力各自通过才算完成。像素图层即使命名为“文字”也不满足。

## 文字与字标分流

- 清晰普通文字：核对原文，确定字体文件及其 PostScript 名称，记录字号、颜色、字距、行距、基线、对齐和缩放，重建原生文字层。多行同样式可用一个文字层，需分别编辑的行独立建层。
- 普通文字附带描边、投影、渐变叠加、删除线或简单斜体：优先保留文字内容并使用原生文字属性/图层样式。价格、型号和小文案不能只因带效果便全部转图片；在实际 PS 中确认改字后效果仍跟随。具体接口与支持范围以当前文档和实测为准，不把复杂特效强塞进下述简单点文字脚本。
- 原字体未知或本机缺少：按共用核验联网查找并比较，展示可信来源、具体字面、授权、费用及安装范围，由用户决定是否安装；安装后重新检查 PS 可用性和实际字形。无法确认匹配时，按 [font-verification.md](font-verification.md) 制作原图文字与编号相似字体的同文对比图，让用户选择；选择前暂保留原字形，不能只停在待解决报告。候选可在独立对比图试排，不写入正式 PSD。用户明确选择并同意相应方案后重建原生文字，状态为用户接受替代，不得标为原字体匹配通过。
- 用户同意安装方案后，继续完成安装/激活与 Photoshop 加载，将通过核验的字体应用到本次目标文字层，保存并读回验证；不只提供安装步骤，不把脚本引用字体文件当成 Photoshop 已使用。实际 Photoshop 不可用时，明确区分 PSD 文件生成检查与应用实测。
- 定制 Logo、滴血、破损、手绘字及复杂立体效果：保持其视觉原画；能准确拆开的特效可独立成层，普通字形仍保留文字。单纯描摹成路径属于可编辑轮廓，不等于文字可编辑。
- 移除底图中的对应旧字并补全背后区域，隐藏文字层时不得露出相同旧字。源图仅作隐藏参考。只测试文字能力时无需扩展成完整人物与场景拆层，但须说明底图仍合并了哪些内容。

## 写入脚本

可以直接通过已验证的 Photoshop 接口建立文字和原生效果，也可以用下面的写入脚本处理其支持的内容。两条路线共用字体核验、逐区覆盖和保存后验收，不要求先写脚本版再重做一份 PS 版。遇到脚本执行、路径孔洞、图层样式或渲染器差异时，按需读取 [ps-compatibility.md](ps-compatibility.md)；其中版本实测是排查线索，不是其他环境的成功保证。

`scripts/build-editable-psd.cjs` 接收经过核对的清单，不负责 OCR、生图、去字、字体下载或自动匹配。每个文字层必须携带 `fontVerification` 记录；缺少、未确认、不匹配或未经接受的替代会被拒绝。脚本检查记录、实际证据图片和字体文件，不自动判断源图字体是否相同，不能把记录检查当作视觉核验。支持 RGB/8、水平点文字、多行同样式、明确字体、字号、颜色、字距、行距、对齐、横纵缩放、像素层及分组。复杂形变、竖排、富文本样式和复杂效果使用已验证的 Photoshop 接口处理，不向此脚本传入其不支持的字段。

依赖安装到任务工作目录的运行库，避免把 `node_modules`、字体或机器路径配置放进 skill：

```powershell
npm install --prefix work/psd-runtime --no-audit --no-fund ag-psd@31.0.3 @napi-rs/canvas@1.0.11 fontkit@2.0.4
node <skill>/scripts/build-editable-psd.cjs work/text.json --output outputs/editable.psd --runtime work/psd-runtime
```

清单中的素材、字体路径相对于清单文件；以下字体文件必须换成实际存在、允许使用的字体，不把示例路径当作已具备字体：

```json
{
  "width": 1200,
  "height": 1800,
  "layersPanelTopToBottom": [
    {
      "type": "text", "name": "标题 · 可编辑", "text": "原图标题",
      "font": { "file": "fonts/actual-font.ttf", "postscriptName": "ActualFontPSName" },
      "fontSize": 48, "x": 600, "baseline": 150, "align": "center",
      "color": "#ffffff", "tracking": 0, "leading": 60,
      "fontVerification": {
        "status": "verified",
        "reviewedPostscriptName": "ActualFontPSName",
        "sourceEvidence": "填写实际识别来源和字形判断依据",
        "referenceFile": "font-check/title-source.png",
        "comparisonFile": "font-check/title-comparison.png"
      }
    },
    { "type": "image", "name": "已移除对应旧字的背景", "file": "clean-background.png" },
    { "type": "image", "name": "原图参考 · 隐藏", "file": "original.png", "visible": false }
  ]
}
```

`x` 为对齐锚点，`baseline` 为首行基线，坐标和字号使用最终画布像素；文档为 72 PPI。`tracking` 使用 Photoshop 的千分之一 em，`horizontalScale`、`verticalScale` 为倍率，默认 1。`group.children` 与根清单均为面板从上到下；不得预先反转。`image` 保留文件像素及可选 `left`、`top`，不自动缩放。

脚本核对独立 TTF/OTF 字体的 PostScript 名称与字符覆盖，缺字时停止而非静默回退；TTC/OTC 集合需先选出独立字面，此脚本不自动选择。字体只引用、不嵌入；编辑端需要同一字体。输出 PSD、从保存后图层像素重合成的预览和报告，不覆盖已有输出，除非显式传入 `--overwrite`。

修改脚本后可运行 `node <skill>/scripts/test-editable-psd.cjs work/psd-runtime <实际字体.ttf> work/psd-selftest`，检查多行文字、分组与遮挡、字体名称错误及缺字失败；并用独立读取器核对测试文件中指定的红蓝交叠像素。31.0.3 的文字读取器会删除末尾所有换行，故此脚本明确拒绝末尾空行，不静默改变原文。

回归还须覆盖：缺核验记录、`unresolved`、`mismatch`、核验字体与实际写入不一致、缺少对照图片、只填旧 `fontMatch` 字段及未获明确接受的替代均被拒绝。测试夹具使用可控的合成文字来源，不能把其通过结果用于证明真实海报字体正确。

## 验证与能力边界

1. 重新读取保存的 PSD，确认目标层为原生文字（如 PS 的 `LayerKind.TEXT` 或读取器的 `kind == 'type'`），并逐字比较文字及字体数据。混合样式检查实际生效的样式范围与字体索引，不把资源表中未使用的备用字体当成回退，也不能只核对默认样式。保留可显示的像素缓存和更新的合并预览。按 [font-verification.md](font-verification.md) 将保存后的实际字形与原图对照；读回预期字体名称不等于与原图匹配。
2. 用独立读取器从实际图层重新合成，核对根节点和组内遮挡顺序、可见性。文字数据读回正确不证明显示正确，内嵌合并图正确也不证明层序正确。
3. 在另存的验证副本中实际改字，保存并重开，检查文字内容、原生类型、字体和效果仍保留。至少覆盖本次不同字体与效果组合中的代表区域；价格有描边时检查改数字后描边仍跟随，原生渐变另检查可调色标或方向。只改一个无效果的小字不能证明其他复杂样式。PS 不可用时，可在 Photopea 做独立编辑与重保存测试，并明确“Photopea 实测，Photoshop 未实测”。通过官方 Live Messaging 接口可传字体字节、PSD 字节及脚本；不把浏览器渲染称为 Photoshop 实测。
4. 隐藏测试文字，确认底图无对应旧字残留；保留原图和未改字的正式结果，改字证明另存。

交付报告关联逐区清单，分别统计实际文字层、原生形状/填充、图形化文字及隐藏参考；明确图形例外和待解决字体。字体替代批准仅覆盖所列区域，不能把“有若干文字层”当作所有普通文字已覆盖。正式文件、改字验证副本和验证导出图分别命名，不能把改过价格或文案的验证副本误交为正式稿。

`ag-psd` 不会自行重画文字缓存；本脚本生成原生文字数据和 Canvas 字形缓存，仍可能因渲染引擎不同产生抗锯齿或排版差异。Photoshop 首次打开可能提示更新文字层；未经 Photoshop 实测不能保证无提示。`invalidateTextLayers` 适用于修改现有文字却未同步缓存的流程，不是绕过缓存校验的方法。支持文件格式不等于已恢复原字体，必须分开报告。

核实依据：[ag-psd 文字说明](https://github.com/Agamnentzar/ag-psd#writing-text-layers)、当前安装版本的 `src/psdWriter.ts` 与 `src/text.ts`、[Photopea Live Messaging](https://www.photopea.com/api/live)。31.0.3 的层序实测见 [psd-assembly.md](psd-assembly.md)。
