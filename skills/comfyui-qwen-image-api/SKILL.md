---
name: comfyui-qwen-image-api
description: "用 ComfyUI API 调 Qwen-Image-2.1：文生图 + 参考图/图生图/编辑。含已验证 workflow、字段坑、完整调用代码、官方参数(cfg=1/steps/euler)、参考图节点与 i2i 操作规范、Prompt Rewriting、透明图与宽高比。当需要经 API 生成或编辑图像时使用。"
---

# ComfyUI API 图像生成/编辑（Qwen-Image-2.1）

经 API 调用 ComfyUI 用 Qwen-Image-2.1 生成/编辑图像。**同一模型**覆盖文生图(t2i) + 指令编辑(edit)，不用换 checkpoint。模型服务部署在 a6000（2×A6000, ComfyUI 0.37.0, INT8 模型），t2i 与 edit 均已实测验证。
官方参考：`QwenLM/Qwen-Image-2.1`（README）+ `Comfy-Org/workflow_templates`（`image_qwen_image_2_1_t2i.json` / `_image_edit.json` / `_background_removal.json`）+ docs.comfy.org 教程。

## 端点（按执行环境选）
- **对外（默认，通用）**：`https://img-api.llm-local.cloud`
  - 适用于 agent 跑在**任意环境**（本地/云/其他机器）。链路：公网→阿里云 nginx→frp→a6000:8188
  - 这是通用入口，不知道环境时就用它
- **本地（仅当脚本跑在 a6000 上）**：`http://127.0.0.1:8188`
  - `127.0.0.1` 是 **a6000 自己的回环**，只有"脚本在 a6000 上执行"（如 `ssh a6000` 后直接跑）才最快（无网络跳转）
  - 若 agent 在别的机器，`127.0.0.1:8188` 不可达，**必须用对外域名**
- 模型（a6000 的 `ComfyUI/models/` 下，INT8 版）：
  - diffusion_models: `qwen_image_2.1_int8_convrot.safetensors`
  - text_encoders: `qwen3vl_8b_int8_convrot.safetensors`
  - vae: `qwen_image_2.1_vae_bf16.safetensors`
- 换模型先查：`GET {BASE}/models?type=unet|clip|vae`
- 节点定义（查字段/排错）：`GET {BASE}/object_info/<NodeName>`

## API 基础
1. `POST /api/prompt`，body 为 `{"prompt": <workflow>}`（**字段名是 `prompt`**）
2. 轮询 `GET /api/history/{prompt_id}`，直到 `outputs.*.images` 出现（1024²/25步 约 25-35s）
3. `GET /view?filename={fn}&subfolder=&type=output` 取图（PNG 字节流）
4. **上传参考图（edit 需要）**：`POST /upload/image`（multipart，字段 `image`=文件、`subfolder`、`type=input`）→ 返回 `{"name","subfolder","type"}`，把 `name` 填进 `LoadImage`。已验证。
   - agent 在 a6000 上时也可直接把图放进 `ComfyUI/input/` 目录，`LoadImage` 默认读 input。

## Workflow 1：文生图 t2i（1024×1024，已验证）
```json
{
  "3":  {"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors","weight_dtype":"default"}},
  "7":  {"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_8b_int8_convrot.safetensors","type":"qwen_image","device":"default"}},
  "16": {"class_type":"CLIPTextEncode","inputs":{"clip":["7",0],"text":"<正面提示词>"}},
  "20": {"class_type":"CLIPTextEncode","inputs":{"clip":["7",0],"text":"<负面提示词>"}},
  "13": {"class_type":"EmptyLatentImage","inputs":{"width":1024,"height":1024,"batch_size":1}},
  "5":  {"class_type":"KSampler","inputs":{"model":["3",0],"seed":42,"steps":25,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0,"positive":["16",0],"negative":["20",0],"latent_image":["13",0]}},
  "11": {"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_2.1_vae_bf16.safetensors"}},
  "6":  {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["11",0]}},
  "12": {"class_type":"SaveImage","inputs":{"filename_prefix":"out","images":["6",0]}}
}
```

## Workflow 2：图像编辑 / 参考图 / 图生图 edit（已验证）
核心节点 **`TextEncodeQwenImage21`**（替代 t2i 的 CLIPTextEncode+EmptyLatentImage）：
- inputs: `clip`、`prompt`、`negative_prompt`、`resolution`(默认1024)、`images`(自动增长列表)、`vae`(可选)
- outputs: `positive`(0)、`negative`(1)、`latent`(2，尺寸=**首张参考图**)
- `images` 传法（**实测确认**）：`"images": [["<LoadImage节点id>",0], ["<另一个LoadImage节点id>",0], ...]`，按顺序对应 `<image1>`、`<image2>`…
- 参考图最多 10 张（`image_1`~`image_10`）；**`image_1` 是编辑目标**，其余是参考

```json
{
  "470": {"class_type":"LoadImage","inputs":{"image":"<目标图.png>"}},
  "475": {"class_type":"LoadImage","inputs":{"image":"<参考图.png>"}},
  "3":   {"class_type":"UNETLoader","inputs":{"unet_name":"qwen_image_2.1_int8_convrot.safetensors","weight_dtype":"default"}},
  "7":   {"class_type":"CLIPLoader","inputs":{"clip_name":"qwen3vl_8b_int8_convrot.safetensors","type":"qwen_image","device":"default"}},
  "11":  {"class_type":"VAELoader","inputs":{"vae_name":"qwen_image_2.1_vae_bf16.safetensors"}},
  "16":  {"class_type":"TextEncodeQwenImage21","inputs":{"clip":["7",0],"vae":["11",0],
            "prompt":"<编辑指令，用 <image1>/<image2> 引用>","negative_prompt":"","resolution":1024,
            "images":[["470",0],["475",0]]}},
  "5":   {"class_type":"KSampler","inputs":{"model":["3",0],"seed":42,"steps":25,"cfg":1.0,"sampler_name":"euler","scheduler":"simple","denoise":1.0,"positive":["16",0],"negative":["16",1],"latent_image":["16",2]}},
  "6":   {"class_type":"VAEDecode","inputs":{"samples":["5",0],"vae":["11",0]}},
  "12":  {"class_type":"SaveImage","inputs":{"filename_prefix":"edit","images":["6",0]}}
}
```
> 官方模板把 edit 封装成子图节点（type 是 UUID）；API 调用按上面**展开成具体节点**即可，已验证。

**`resolution`（edit 关键）**：参考图缩到约 `resolution×resolution` 像素**总预算**（保持宽高比，multiples of 32）。默认 1024；**`0`=保持每张参考图原尺寸**（只对齐 32）；输出跟随 `image_1` 的比例/尺寸。
**局部编辑**：只描述要改的物体/区域，其余自动保留。
**去背景**：edit workflow + prompt `Remove the background`（官方 background_removal 模板）。

## 字段坑（实测，务必遵守）
1. 请求体是 `{"prompt": <wf>}`，不是 `{"workflow": ...}` → 否则 `No prompt provided`
2. `UNETLoader` 字段是 **`unet_name`**（不是 model_name）
3. `VAELoader` 字段是 **`vae_name`**
4. t2i：`KSampler.latent_image` **必填**；传 `null` 报 `'NoneType' object is not subscriptable` → 用 `EmptyLatentImage`，传 `["13",0]`
5. edit：`KSampler.latent_image` 来自 `TextEncodeQwenImage21` 的第3输出 `["16",2]`（**不要**用 EmptyLatentImage，否则尺寸/内容不符，编辑会错位）
6. 出图时 ComfyUI 高负载，`/api/history` 偶尔超时 → 轮询 catch 异常重试
7. 查错：history 里 `status.status_str=="error"` 时，看 `status.messages` 的 `execution_error`（`node_id`+`exception_message`）
8. 查节点字段：`GET /object_info/<NodeName>`（本 skill 的字段均据此实测确认）

## 官方参数（来自 Comfy-Org 模板 Note）
| 参数 | 官方值 | 说明 |
|------|--------|------|
| **cfg** | **1.0（恒为 1）** | 官方路径恒 1；`negative_prompt` 在 cfg=1 时**被忽略**，要用负面词才调高 cfg |
| **steps** | **25–40** | 官方 pipeline 40-50，模板默认 25；求质量 40 |
| **sampler/scheduler** | **euler / simple** | 官方组合 |
| 分辨率 | 1024² 或 2048² | 原生 2K；**prefer multiples of 32** |
| denoise | 1.0 | t2i 与 edit 都 1.0 |

**官方宽高比表（原生 2K，t2i 用 ResolutionSelector/EmptyLatentImage 设）**：
| 比例 | 尺寸 | 比例 | 尺寸 |
|------|------|------|------|
| 1:1 | 2048×2048 | 16:9 | 2752×1536 |
| 4:3 | 2400×1792 | 9:16 | 1536×2752 |
| 3:4 | 1792×2400 | 3:2 | 2528×1696 |
| 2:3 | 1696×2528 | | |
（1024 档位等比缩，如 1:1→1024, 16:9→1344×768。edit 的尺寸跟随参考图，见 `resolution`）

## 完整调用代码（Python，无第三方依赖）
### t2i
```python
import json, urllib.request, time, ssl
BASE = "https://img-api.llm-local.cloud"   # 或 a6000 上：http://127.0.0.1:8188
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
wf = { ...上面的 t2i workflow，替换 16/20 的 text、13 的 width/height、5 的 steps... }
pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE+"/api/prompt",
        data=json.dumps({"prompt":wf}).encode(), method="POST",
        headers={"Content-Type":"application/json"}), timeout=30, context=ctx).read())["prompt_id"]
for _ in range(180):
    time.sleep(2)
    try: h = json.loads(urllib.request.urlopen(BASE+"/api/history/"+pid, timeout=20, context=ctx).read())
    except Exception: continue
    node = h.get(pid, {}); st = node.get("status", {})
    if st.get("status_str")=="error":
        for m in st.get("messages", []):
            if m[0]=="execution_error": raise SystemExit(f"node {m[1].get('node_id')}: {m[1].get('exception_message')}")
        break
    for k,v in node.get("outputs",{}).items():
        if "images" in v:
            fn=v["images"][0]["filename"]
            img=urllib.request.urlopen(BASE+f"/view?filename={fn}&subfolder=&type=output", timeout=90, context=ctx).read()
            open("out.png","wb").write(img); assert img[:4]==b"\x89PNG"; raise SystemExit("done: out.png")
raise SystemExit("timeout")
```
### edit（含上传参考图）
```python
import json, urllib.request, time, ssl, uuid
BASE = "https://img-api.llm-local.cloud"
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE

def upload(local_path):
    b = uuid.uuid4().hex; fn = local_path.split("/")[-1]; data = open(local_path,"rb").read()
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{fn}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + \
           (f"\r\n--{b}\r\nContent-Disposition: form-data; name=\"subfolder\"\r\n\r\n\r\n"
            f"--{b}\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\ninput\r\n--{b}--\r\n").encode()
    r = urllib.request.Request(BASE+"/upload/image", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={b}"})
    return json.loads(urllib.request.urlopen(r, timeout=60, context=ctx).read())  # {"name","subfolder","type"}

u1 = upload("target.png")    # 编辑目标 -> <image1>
u2 = upload("ref.png")       # 参考     -> <image2>
wf = { ...上面的 edit workflow，470.inputs.image=u1["name"]，475.inputs.image=u2["name"]，16.prompt=编辑指令... }
# 之后 POST /api/prompt + 轮询，与 t2i 完全相同
```

## 提示词优化（Qwen-Image）
### t2i 核心原则（官方 + 社区共识）
- **详细描述句 > 关键词堆砌**：官方示例是超长描述句
- **中英文都可**（官方 Prompt Rewriting 输出英文长句）
- **主体放最前**（模型对开头权重最高）
- **结尾加约束**：`无文字，无水印`（官方 `no text, no typography... no watermark`）
- **长度**：50–200 字（官方示例可达 300+ 字）
- 结构化：主体→动作→环境→光线→构图→风格→质量词→负面约束
- **文字渲染**（强项）：海报/招牌的文字**用引号直接写进提示词**，如 `写着"限时五折"`
- 模板：`[主体细节]，[动作]，[环境]，[光线]，[构图]，[风格]，高质量，细节清晰。无文字，无水印。`

### edit 提示词（指令式，官方推荐）
- **指令式**，直接说要改什么；用 **`<image1>`/`<image2>`/… 引用参考图**（`<image1>`=`image_1`=编辑目标）
- **只描述要改的物体/区域**，其余自动保留；强调"保留身份/姿势/背景/光照"
- 官方示例（换装）：`Keep the character and pose in <image1> unchanged, put this light blue denim shirt from <image2> on the character, preserve the original facial features, hair, body shape and pose, the denim shirt fits naturally, realistic denim fabric texture, keep the original background and lighting, high fashion editorial photography, sharp details`
- 去背景：`Remove the background`
- 多参考图：`Combine the subject of <image1> with the setting of <image2> and the style of <image3>, ...`

### 官方 Prompt Rewriting（最佳效果推荐）
用 Prompt Rewriting 模型把短 prompt 扩成长 prompt + 自动选宽高比：
- T2I: `Qwen/Qwen-Image-2.1-PE-T2I`（Qwen3.5-VL 9B）；Edit: `Qwen/Qwen-Image-2.1-PE-I2I`
- 输出 `{"rewritten_prompt": "<长描述>", "wh_ratio": "16:9"}` → 喂给 pipeline，wh_ratio 查表定尺寸
- 轻量替代：用任意强 LLM（如本机 vLLM 的 Qwen）按上面规则扩写

### 负面提示词
- **cfg=1 时 negative 被忽略**（官方默认）。要用就 cfg 调 1.5–2
- 推荐：`低质量，模糊，变形，多余手指，水印` / `low quality, blur, deformed, extra fingers, watermark`

### 透明图（原生 RGBA）
官方格式（替换中间描述），存 PNG 保留 alpha：
> `This is an RGBA format image with transparency. <你的描述>. The image has an alpha channel and a transparent background.`

## 性能参考（a6000 INT8）
- 1024² / 25 步 ≈ 25-35s（t2i 与 edit 相近）
- 2048² 原生 2K 更慢（约 2-3 倍）
- 出图峰值显存 ~15GB；与 vLLM(gpu-mem-util 0.5) 共存时 GPU0 约 44.6/48GB（偏紧但可用）
- 对外域名比本地多一跳（nginx+frp），出图耗时基本相同（瓶颈在 GPU 生图，不在网络）

## 图生图 / 局部细节编辑（保留底图，经典 i2i）
- 适用：修好特定图上的细节（手/脸/道具）且保留整体构图。不用 `TextEncodeQwenImage21`（其 latent 输出是空的，denoise<1.0 时出废图；该节点只配 denoise=1.0 的 edit 流程用）
- Workflow：`LoadImage → VAEEncode → KSampler(denoise 0.4–0.7, cfg=1.0, euler/simple) → VAEDecode → SaveImage`；`KSampler.latent_image` 接 `VAEEncode` 输出
- 局部修复：正向 prompt 写显式约束（cfg=1 时 negative 被忽略，约束必须写正向），例："右手恰好四指加一只拇指自然环握杖身，手心下方没有任何多余手指"
- denoise 参考：0.45 保留构图且允许局部重选；改动越小取值越低
