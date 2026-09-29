---
name: comfyui-minimax-music3-api
description: "用 ComfyUI API 调 MiniMax Music 3 生成完整歌曲（文生音乐 t2m）。含已验证 workflow、字段坑、官方参数(cfg=1.7/steps=30/euler)、Caption 三段式 + Lyrics 结构标签提示词规范、完整调用代码、模型下载。当需要经 API 生成音乐/歌曲时使用。"
---

# ComfyUI API 文生音乐（MiniMax Music 3）

经 API 调用 ComfyUI 用 **MiniMax Music 3** 生成**完整歌曲**（最长 ~5 分钟，含结构：intro/verse/chorus/bridge/outro，可带人声或纯器乐）。两个输入驱动：**Caption**（音乐描述，三段式）+ **Lyrics**（带结构标签的歌词）。模型服务部署在 a6000（2×A6000, ComfyUI 0.37.0），与 Qwen-Image 共用同一 ComfyUI 实例与反向代理。

官方参考：`MiniMax-AI/MiniMax-Music3`（README + 官方 Music Caption Rewriter Skill）+ `Comfy-Org/workflow_templates`（`audio_minimax_music_3.json`）+ docs.comfy.org。

## 端点（按执行环境选，与 Qwen-Image 相同）
- **对外（默认，通用）**：`https://img-api.llm-local.cloud`
  - 适用于 agent 跑在**任意环境**。链路：公网→阿里云 nginx→frp→a6000:8188
  - 该域名代理的是 a6000 的整个 ComfyUI，音频 API 同样走它
- **本地（仅当脚本跑在 a6000 上）**：`http://127.0.0.1:8188`
- 模型（a6000 的 `ComfyUI/models/` 下）：
  - diffusion_models: `minimax_music3_dit_fp16.safetensors`（~4.9G）
  - text_encoders: `minimax_music3_text_encoder_pruned_int8_convrot.safetensors`（~9.2G）
  - vae: `minimax_music3_dav.safetensors`（~216M）
- 换模型先查：`GET {BASE}/models?type=unet|clip|vae`
- 节点定义（查字段/排错）：`GET {BASE}/object_info/<NodeName>`

## API 基础（与 Qwen-Image 相同，输出是音频不是图）
1. `POST /api/prompt`，body 为 `{"prompt": <workflow>}`（**字段名是 `prompt`**）
2. 轮询 `GET /api/history/{prompt_id}`，直到 `outputs.*.audio` 出现（60s 歌曲约 2-5 分钟，视 GPU）
3. `GET /view?filename={fn}&subfolder=&type=output` 取音频（mp3/wav 字节流）
4. 轮询时 catch 异常重试（生成长、ComfyUI 高负载时 `/api/history` 偶尔超时）

## Workflow：文生音乐 t2m（已验证节点链路）
```json
{
  "1": {"class_type":"UNETLoader","inputs":{"unet_name":"minimax_music3_dit_fp16.safetensors","weight_dtype":"default"}},
  "2": {"class_type":"CLIPLoader","inputs":{"clip_name":"minimax_music3_text_encoder_pruned_int8_convrot.safetensors","type":"minimax","device":"default"}},
  "3": {"class_type":"VAELoader","inputs":{"vae_name":"minimax_music3_dav.safetensors"}},
  "4": {"class_type":"MiniMaxMusic3TextEncode","inputs":{"clip":["2",0],"caption":"<三段式音乐描述>","lyrics":"<带标签歌词>","seed":42,"max_duration":60.0,"cfg_scale":1.7,"top_k":50}},
  "5": {"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
  "6": {"class_type":"EmptyMiniMaxMusic3LatentAudio","inputs":{"seconds":["4",1],"batch_size":1}},
  "7": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["4",0],"negative":["5",0],"latent_image":["6",0],"seed":42,"steps":30,"cfg":1.7,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
  "8": {"class_type":"VAEDecodeAudio","inputs":{"samples":["7",0],"vae":["3",0]}},
  "9": {"class_type":"SaveAudioAdvanced","inputs":{"audio":["8",0],"filename_prefix":"music3/test","format":"mp3","quality":"V0"}}
}
```

**链路要点（与 Qwen-Image 图像流程的关键差异）：**
- `CLIPLoader` 的 `type` = **`"minimax"`**（图像 Qwen-Image 是 `"qwen_image"`，别搞混）
- `MiniMaxMusic3TextEncode` 输出 2 路：`[4,0]`=CONDITIONING（接 positive）、`[4,1]`=**seconds**（FLOAT，实际时长，接 `EmptyMiniMaxMusic3LatentAudio.seconds`）
- **negative 用 `ConditioningZeroOut`**（`[5,0]`，把 positive 清零）——音乐模型没有传统负面提示词
- `EmptyMiniMaxMusic3LatentAudio`（不是 EmptyLatentImage）：`seconds` 接 `[4,1]`、`batch_size`=1 → 生成音频 latent
- 解码用 **`VAEDecodeAudio`**（不是图像 VAEDecode）
- 保存用 **`SaveAudioAdvanced`**（`format`=flac/mp3/opus；**mp3 必须附 `quality`=V0/128k/320k**；flac 无此参数最省事）

## 节点字段（object_info 实测）
- **MiniMaxMusic3TextEncode**: inputs `clip`(CLIP)、`caption`(STRING)、`lyrics`(STRING)、`seed`(INT)、`max_duration`(FLOAT,默认120,范围0.04-360)、`cfg_scale`(FLOAT,默认1.5)、`top_k`(INT,默认50) → outputs `CONDITIONING`(0)、`seconds`(1,FLOAT)
- **EmptyMiniMaxMusic3LatentAudio**: inputs `seconds`(FLOAT)、`batch_size`(INT) → `LATENT`
- **SaveAudioAdvanced**: inputs `audio`(AUDIO)、`filename_prefix`(STRING)、`format`(COMBO: flac/mp3/opus；mp3/opus 附 `quality`) → `AUDIO`
- **VAEDecodeAudio**: inputs `samples`(LATENT)、`vae`(VAE) → `AUDIO`

## 官方参数（来自 Comfy-Org 模板 Note）
| 参数 | 官方值 | 说明 |
|------|--------|------|
| **cfg (KSampler)** | **1.7** | 官方模板值（图像 Qwen-Image 是 1.0，别混） |
| **steps** | **30** | 官方模板默认 |
| **sampler/scheduler** | **euler / simple** | 官方组合 |
| **max_duration** | 120（默认）| 目标秒数，支持到 ~300s/5min；模型可能提前结束。越长越费时间/显存 |
| **denoise** | 1.0 | 恒 1.0 |
| top_k | 50 | TextEncode 的采样参数 |

## 提示词规范（关键，与图像提示词完全不同）
两个输入分工：
- **Caption** = 音乐描述，写**三段**（越具体越贴近）：
  1. `Global Metadata:` 风格、BPM、调性、情绪、场景（如 `Lo-fi hip-hop, chillhop. 78 BPM, D flat major...`）
  2. `Vocal Details:` 人声描述（音色、唱法、在混音中的位置；纯器乐可写 `instrumental, no vocals`）
  3. `Arrangement:` 编曲/乐器、各段落（Intro/Verse/Chorus/Bridge/Outro）的乐器进出
- **Lyrics** = 歌词 + **结构标签**（标签是唯一的可执行结构指令，歌词本身只传情绪）：
  - 标签：`[Intro]` `[Verse]` `[Pre-Chorus]` `[Chorus]` `[Bridge]` `[Instrumental]` `[Outro]`
  - 纯器乐：lyrics 留空或只写标签
  - 官方模板示例的 caption 极长（含制作细节如 vinyl crackle、tape hiss），可参考

**官方 Music Caption Rewriter Skill**（最佳效果）：`MiniMax-AI/MiniMax-Music3` 仓库提供把短描述重写成规范 caption 的 skill。轻量替代：用任意强 LLM 按上面三段式扩写 caption。

## 完整调用代码（Python，无第三方依赖）
```python
import json, urllib.request, time, ssl
BASE = "https://img-api.llm-local.cloud"   # 或 a6000 上：http://127.0.0.1:8188
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE

CAPTION = ("Global Metadata: Acoustic pop ballad. 90 BPM, C major, warm and sincere. "
           "Gentle fingerpicked guitar driven, hopeful and relaxed mood throughout.\n\n"
           "Vocal Details: Clear warm male vocal, steady relaxed delivery, front and clear in the mix.\n\n"
           "Arrangement: Fingerpicked acoustic guitar leads, soft bass, light brushed drums, subtle piano. "
           "Intro: guitar alone. Verses: guitar and vocal. Chorus: add drums and bass, fuller.")
LYRICS = ("[Intro]\n\n[Verse]\nWalking down the familiar street,\nSunlight falling on my face.\n\n"
          "[Chorus]\nWe are together under the sky,\nEvery moment we won't say goodbye.\n")

wf = {
  "1": {"class_type":"UNETLoader","inputs":{"unet_name":"minimax_music3_dit_fp16.safetensors","weight_dtype":"default"}},
  "2": {"class_type":"CLIPLoader","inputs":{"clip_name":"minimax_music3_text_encoder_pruned_int8_convrot.safetensors","type":"minimax","device":"default"}},
  "3": {"class_type":"VAELoader","inputs":{"vae_name":"minimax_music3_dav.safetensors"}},
  "4": {"class_type":"MiniMaxMusic3TextEncode","inputs":{"clip":["2",0],"caption":CAPTION,"lyrics":LYRICS,"seed":42,"max_duration":60.0,"cfg_scale":1.7,"top_k":50}},
  "5": {"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},
  "6": {"class_type":"EmptyMiniMaxMusic3LatentAudio","inputs":{"seconds":["4",1],"batch_size":1}},
  "7": {"class_type":"KSampler","inputs":{"model":["1",0],"positive":["4",0],"negative":["5",0],"latent_image":["6",0],"seed":42,"steps":30,"cfg":1.7,"sampler_name":"euler","scheduler":"simple","denoise":1.0}},
  "8": {"class_type":"VAEDecodeAudio","inputs":{"samples":["7",0],"vae":["3",0]}},
  "9": {"class_type":"SaveAudioAdvanced","inputs":{"audio":["8",0],"filename_prefix":"music3/demo","format":"mp3","quality":"V0"}},
}
pid = json.loads(urllib.request.urlopen(urllib.request.Request(BASE+"/api/prompt",
        data=json.dumps({"prompt":wf}).encode(), method="POST",
        headers={"Content-Type":"application/json"}), timeout=30, context=ctx).read())["prompt_id"]
print("queued:", pid)
for _ in range(360):  # 最多 ~30 分钟
    time.sleep(5)
    try: h = json.loads(urllib.request.urlopen(BASE+"/api/history/"+pid, timeout=20, context=ctx).read())
    except Exception: continue
    node = h.get(pid, {}); st = node.get("status", {})
    if st.get("status_str")=="error":
        for m in st.get("messages", []):
            if m[0]=="execution_error": raise SystemExit(f"node {m[1].get('node_id')}: {m[1].get('exception_message')}")
        break
    for k,v in node.get("outputs",{}).items():
        if "audio" in v:
            f=v["audio"][0]; fn=f["filename"]; sub=f.get("subfolder","")
            url=BASE+f"/view?filename={fn}&subfolder={sub}&type=output"
            audio=urllib.request.urlopen(url, timeout=120, context=ctx).read()
            open("out.mp3","wb").write(audio); print("done: out.mp3", len(audio)//1024, "KB"); raise SystemExit(0)
raise SystemExit("timeout")
```

## 模型下载（ModelScope，a6000 直连快）
```bash
cd /home/amax/ComfyUI/models
BASE="https://modelscope.cn/models/Comfy-Org/MiniMax-Music-3/resolve/main"
# 断点续传（-C -）直接下到目标路径；约 14.3GB
curl -s -L -C - "$BASE/diffusion_models/minimax_music3_dit_fp16.safetensors" -o diffusion_models/minimax_music3_dit_fp16.safetensors &
curl -s -L -C - "$BASE/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors" -o text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors &
curl -s -L -C - "$BASE/vae/minimax_music3_dav.safetensors" -o vae/minimax_music3_dav.safetensors &
wait
ls -l diffusion_models/minimax_music3_dit_fp16.safetensors text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors vae/minimax_music3_dav.safetensors
```
> ModelScope 速度 ~5-10MB/s，14GB 约需 25-45 分钟，**后台任务超时要给足（≥60min）**。HuggingFace 同名仓库 `Comfy-Org/MiniMax-Music-3`（a6000 无公网，走 ModelScope）。

## Caption 进阶规范（官方 caption-rewriter + 社区共识，2026-09 实战）

官方仓库 `MiniMax-AI/MiniMax-Music3` 自带 music-caption-rewriter skill（`npx skills add MiniMax-AI/MiniMax-Music3 --skill music-caption-rewriter`），其规范要点：

1. **长度**：caption 建议 250-450 词（英文）。社区验证：长结构化 caption 明显优于短提示词
2. **不写死 BPM/调性**：用定性描述（如 `very slow, rubato feel`）；精确 BPM 仅在必要时写
3. **情绪弧线**：Global Metadata 必须写出明确的情绪推进（如 孤寂→回忆→渴望→释然），不能只写静态 mood 形容词
4. **Arrangement 写成逐段 timeline**：每段哪些乐器进/变化/出，转场要音乐上合理
5. **歌词里只有方括号标签是结构指令**：括号内演奏指示别留歌词里（会被唱出来），全部转进 caption 的 Arrangement

### 速度与乐句（多轮迭代实测）
- 模型对写死的 BPM 数字常不真照做，**总时长跟随内容密度**；prompt 里写的时长也只是软建议
- 想放慢：**把长歌词行拆成短行**（每行 4-10 字，一行一呼吸）+ 定性慢速描述 + 明确"每句唱完停满一拍再唱下一句"
  - 实测：同一歌词从每行 14 字改 7 字 + 55BPM 描述，总时长 2:50→3:50（真放慢了）
- 注意：`free-time rubato` 描述可能让模型反而压缩总时长（3:50→2:33），出片后核时长
- 修正"前奏/间奏韵律怪"：intro 明确写 free-time rubato 独奏钢琴（无固定拍），正文进稳定简单 4/4 脉冲，并写明"副歌鼓点进来但节奏绝不改变"

### 人声情感（社区公认弱点，需主动推）
- Suno 社区共识：Music 3 人声情感偏平、节奏受限（cinematic/中文抒情是强项，rock/metal 反馈一般）
- 在 Vocal Details 直接写 `This is SINGING, NOT READING` + 具体表演指令：最痛的字带轻微哽咽、长音尾字加颤音、关键词要有情绪重音、verse 贴麦低语→chorus 打开但不喊不加速

### Seed 策略
- 模型很吃种子：单版平庸（情感平/乐句怪）时，**同一 caption 并行跑 2-3 个 seed**（各 ~5 分钟，可并行）挑最佳，比盲目改参数更有效

### 时长核验（本机无 ffprobe 时）
用 python 标准库读 FLAC STREAMINFO（8 字节值从 block 数据偏移 +10 起）：
```python
v = int.from_bytes(data[i+10:i+18], 'big')
sr = (v>>44) & 0xFFFFF; ch = (v>>41) & 7; ns = v & ((1<<36)-1)
duration = ns / sr
```

## 性能参考（a6000 实测）
- **60s 歌曲 / 30 步 ≈ 80s**（含模型加载；A6000 很快）
- **显存：Music 3 只用单卡（GPU0）**，自身峰值约 14-15GB（DiT fp16 5G + TE int8 9G 按需 offload + 采样激活）。与 vLLM(gpu-mem-util 0.5) 共存时 GPU0 总 ~45/48GB（偏紧但未 OOM）
- 更长歌曲：时间近似线性（120s 估 ~2.5-3min，300s 更久）；低显存可换 `VAEDecodeAudioTiled`（tiled 解码省显存，接缝风险略增）
- **输出格式用 flac**（`SaveAudioAdvanced format=flac`）：mp3 的 `quality` 是 `COMFY_DYNAMICCOMBO_V3` 子字段（`format.quality`），API 顶层传 `quality` 不被识别（报 `Required input is missing: quality`）
