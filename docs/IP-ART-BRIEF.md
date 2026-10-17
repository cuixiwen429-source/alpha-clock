# Halfie & Friends — 像素 IP 绘图需求文档

给 AI 绘图模型（Grok Imagine / GPT-Image-2.5 等）用的完整提示词文档。项目是 Monad Blitz 黑客松参赛作品「半衰期 / Alpha Clock」，一条消息的价格每 400 毫秒衰减一点，最终免费公开。

---

## 0. 世界观（画图前必读，决定气质基调）

**神话背景：普罗米修斯盗火。**

奥林匹斯的火只属于众神。普罗米修斯把它藏进一根茴香秆，偷偷带下山。但火一离开奥林匹斯就开始变冷——每过一瞬就有一颗火星飘走，落进某个伸出手的凡人掌心。越早伸手，接到的火越烫，代价也越高。时间之神 Chronos 决定火冷却的速度，谁也改不了；但什么时候伸手，由 Kairos（“时机”之神）决定。当最后一颗火星飘落，火不再属于任何人，它属于所有人。

这组 IP 就是围绕这团火和伸手接火的角色。**整体气质：温暖但克制，不卖萌，不走可爱风，接近「希腊神话插画 × 复古街机游戏」的交叉点**——想象《哈迪斯》(Hades) 游戏的神话感，揉进 8-bit/16-bit 像素游戏的颗粒质感。不要走 Q 版吉祥物、不要走 NFT 头像集那种扁平卡通风。

---

## 1. 技术规格（所有角色统一遵守）

- **画布**：16×16 像素网格为基准构图，但**最终出图分辨率要高**（建议至少 512×512 或 1024×1024），像素块清晰可数、边缘锐利无抗锯齿模糊——即“大颗粒像素风”，不是“低清糊图”。参考 2D 像素游戏里放大展示的角色立绘效果。
- **背景**：纯色或透明背景，方便后续抠图合成到深色 UI 界面上。如果做不到透明，用接近纯黑 `#08090A` 的背景。
- **视角**：正面或 3/4 侧身站立姿态，角色占画面主体，居中，无裁切。
- **描边**：角色外轮廓有清晰的深色描边（除 Halfie 用紫色描边，见下）。
- **风格关键词（通用）**：`pixel art`, `retro game sprite`, `16-bit style`, `Greek mythology`, `warm but restrained palette`, `crisp hard edges`, `no anti-aliasing`, `centered composition`, `transparent or solid dark background`

---

## 2. 调色板（严格限制在这组颜色内，不要引入新色系）

这是整个项目 UI 的既有色板，角色配色必须从这里取色，保证放进界面后视觉统一：

| 用途 | 颜色 | HEX |
|---|---|---|
| 背景深色 | 近黑 | `#08090A` |
| 表面深色 | 深灰黑 | `#101113` / `#16181B` |
| 文字高光 | 近白 | `#F2F3F5` |
| 文字次级 | 灰 | `#8A8F98` |
| 文字三级 | 深灰 | `#5C616B` |
| **火焰-热**（价格刚发布，最贵） | 琥珀金 | `#FFC53D` |
| **火焰-温**（价格降了一半） | 暗金 | `#D9A63C` |
| **火焰-冷**（价格快归零） | 冷灰 | `#8E939C` |
| **火焰-将灭** | 深灰 | `#6E747E` |
| **免费/重生** | 青绿 | `#3DDC97` |
| 致敬色（仅 Halfie 描边用） | 紫 | `#8B5CF6` |

---

## 3. 角色一：Halfie（主角 IP）

### 故事
> 普罗米修斯从奥林匹斯带下来的火种里，有一团最小的，只有 256 颗火星，它叫 Halfie。它知道自己留不住。每 400 毫秒就有一颗火星离开它，飞向某个伸出手的人。它从琥珀色慢慢变灰，越来越轻。但它从不难过。它说：「我不是在熄灭，我是在被分完。」最后一颗火星飘走的那一刻，Halfie 消失了，又在每个人手里亮了起来，变成青绿色。

### 视觉描述
一团**悬浮的、半透明的小火焰生物**——不是动物造型，是火苗本身拟人化了。整体轮廓像一滴倒置的水滴融合跳动的火尖：顶部有一撮像蜡烛火苗一样摇曳的尖，往下逐渐变宽变圆，底部没有脚，直接悬空或虚化消散。

- **形体结构**：顶部窄而跳跃（像火焰尖），中段最宽，底部圆润并逐渐透明消散（表示它脚下其实没有实体，是悬浮的能量体）。
- **颜色分层**（从外到内，模拟正在冷却的火）：最外层边缘是琥珀金 `#FFC53D`，中间一层暗金 `#D9A63C`，再往内是冷灰 `#8E939C`，核心是深灰 `#6E747E`。整体看起来像一团正在从暖色过渡到冷色的火焰，边缘比核心更亮更暖（真实火焰的光学效果）。
- **表情/五官**：只有一对眼睛，没有嘴、没有四肢。眼睛是两个简单的近白色 `#F2F3F5` 圆点或椭圆，位于火焰中段偏上的位置，表情平静、略带温柔的凝视感，不要卖萌、不要睁太大、不要有瞳孔高光那种可爱风处理。
- **描边**：整体外轮廓用紫色 `#8B5CF6` 描边（唯一用紫色描边的角色，其余角色都用深色/黑色描边）。
- **动态感**：轮廓边缘可以画得略不规则、像跳动的火苗那样有几处小尖角凸起，表示它在轻微燃烧摆动，但整体保持对称和稳定感，不要画得太狰狞或太锐利。

### 风格提示词草稿
```
A small floating flame-spirit creature, pixel art style, 16-bit retro game sprite, 
teardrop-shaped body with a flickering flame tip at top, rounded body fading into 
translucent wisps at the bottom (no legs, hovering), gradient coloring from warm 
amber (#FFC53D) at the outer edge through dark gold (#D9A63C) and cool gray 
(#8E939C) toward a deeper gray (#6E747E) core, simulating a cooling flame, 
two simple calm pale-white (#F2F3F5) dot eyes near the upper-middle, no mouth, 
no limbs, purple (#8B5CF6) outline around the entire silhouette, Greek mythology 
inspired "stolen fire spirit" character, gentle and serene expression, not cute 
or cartoonish, centered composition, solid dark (#08090A) or transparent background, 
crisp pixel edges, no anti-aliasing, high resolution pixel art (1024x1024 upscaled 
from 16x16 grid logic)
```

---

## 4. 角色二：Bolt（闪电碎片）— 第一个买家阵营

### 故事
> 火被偷走的那晚，宙斯掷出了一道雷霆，没打中。雷霆在山脚碎成了几百片，其中一片醒了过来，就是 Bolt。它是唯一亲眼看见火被偷的东西，所以它永远第一个知道。Bolt 不讨价还价。它出现的时候价格最高，它不在乎。它只说一句话：「我比你们早。」

### 视觉描述
**不是生物，是一块有生命的碎石/晶体**——宙斯雷霆劈碎后的一块棱角分明的石头碎片，表面裂着一道闪电状纹路。

- **形体结构**：不规则多边形碎石，整体直立，顶部和底部各有一个锐利的锯齿尖角（像打碎的石头自然形成的棱角），没有四肢、没有明确的"头部"，是纯粹的几何碎块造型。
- **颜色**：主体是近白色 `#F2F3F5`，像带着雷电余温的浅色矿石。外缘有一层琥珀金 `#FFC53D` 的发光描边（不是黑色描边，是发光的暖色边缘，表示它仍带电）。
- **表面细节**：石头表面刻着一道"之"字形（闪电形）裂缝，裂缝颜色用深背景色 `#08090A`，像是闪电纹路直接刻进石头里发黑的痕迹。
- **五官**：完全没有眼睛、嘴巴或任何面部特征——它是碎片，不是生物，这点要坚持。
- **动态感**：边缘可以有几处细小的白色像素点"溅出"或"闪烁"，表示它带电、不稳定，随时可能再次炸裂。

### 风格提示词草稿
```
A jagged crystalline rock fragment with sharp angular edges, pixel art style, 
16-bit retro game sprite, broken shard of lightning/thunder, pale white (#F2F3F5) 
main body with a glowing amber (#FFC53D) outline instead of black outline, a 
jagged zigzag lightning-bolt-shaped crack running through the surface rendered 
in dark near-black (#08090A), no face, no eyes, no limbs, pure geometric fragment 
shape with sharp pointed tips at top and bottom, small white pixel sparks floating 
near the edges suggesting static electricity, Greek mythology inspired "fragment 
of Zeus's thunderbolt", crackling energy feel, centered composition, solid dark 
(#08090A) or transparent background, crisp pixel edges, no anti-aliasing, high 
resolution pixel art
```

---

## 5. 角色三：Rush（狐狸）— 第 1–3 个半衰期买家阵营

### 故事
> 传说忒拜有一只狐狸，命中注定永远不会被抓住。众神派出一条命中注定能抓住一切的猎犬去追它，追到最后，宙斯只好把它俩都变成了石头。Rush 是那只狐狸的后代。它不像 Bolt 那样第一个到，但它嗅得到风声。人群还在犹豫，它已经叼着火星跑远了。「早一点就够了，」它说，「不用最早。」

### 视觉描述
标准狐狸侧身剪影，**奔跑姿态**，整体修长灵巧。

- **形体结构**：侧身 3/4 角度，身形修长。三角形耳朵直立，尾巴粗壮上扬，长度接近身体一半，表示奔跑中的动态平衡。四肢呈奔跑交叉状——前脚向前伸出，后脚向后蹬，制造"冲刺中"的瞬间感。
- **颜色**：身体主色是暗金 `#D9A63C`（对应它买入时价格已经从最热降到中段）。腹部和尾尖用深色 `#16181B` 做经典狐狸配色的反转处理（深色背景下用深色代替传统浅色腹部）。耳朵内侧点 1-2 处近黑色 `#08090A` 像素。
- **五官**：一只眼睛可见（侧身视角），用近白色 `#F2F3F5` 像素点表示，瞳孔直接用黑色描边围出的空白表示，不需要单独画瞳孔细节（避免过度细节化）。嘴部可以有一个简单的深色三角形鼻尖。
- **描边**：整体黑色/深色描边。
- **动态感**：整个姿态要强调"在奔跑"——这是和其他角色最大的区分点，其余角色都是静止姿态，只有 Rush 在动。

### 风格提示词草稿
```
A fox in mid-sprint running pose, side three-quarter view, pixel art style, 
16-bit retro game sprite, sleek slender fox silhouette, triangular upright ears, 
thick tail raised and trailing suggesting speed, front legs stretched forward 
and back legs kicked back in a dynamic running stride, dark gold (#D9A63C) main 
body color, dark (#16181B) belly and tail-tip as color inversion of classic fox 
coloring, one visible pale-white (#F2F3F5) eye with simple pupil, small dark 
triangular nose, black outline, Greek mythology inspired "the uncatchable fox 
of Thebes", agile and quick feeling, captured mid-motion, centered composition, 
solid dark (#08090A) or transparent background, crisp pixel edges, no anti-aliasing, 
high resolution pixel art
```

---

## 6. 角色四：Hoot（猫头鹰）— 第 3–8 个半衰期买家阵营

### 故事
> Hoot 是雅典娜的猫头鹰。哲学家说过，智慧的猫头鹰只在黄昏起飞。所以它不急。它蹲在神庙的柱子上，看着火一点点变冷，在心里算：现在的价格，值不值？等它终于张开翅膀，火已经不烫了，价格刚刚好。「我不是慢，」Hoot 说，「我是算完了。」

### 视觉描述
圆胖身形的猫头鹰，**静止站立姿态**，整体气质是"在观察、在计算"。

- **形体结构**：身体圆胖，正面或微侧站立，翅膀收拢贴着身体两侧（表示还未出手行动）。头顶两簇小耸起的耳羽。头部比例略大于身体（卡通化处理，强化"大眼睛观察"的特征）。
- **颜色**：身体主色是冷灰 `#8E939C`（对应买入时价格已经冷下来）。翅膀和面部的"面盘"区域用深色 `#16181B` 和冷灰 `#8E939C` 做 2-3 条横向色块分层，模拟羽毛纹理（不需要画出单根羽毛细节）。
- **五官（全图最大特征）**：两个巨大的圆形眼睛占据头部近一半面积，瞳孔用深背景色 `#08090A` 实心填充，眼眶用近白色 `#F2F3F5` 描边勾出——这对眼睛是整张图的视觉重心。喙是一个小三角形，用琥珀金 `#FFC53D` 上色，是全图唯一的暖色点，表示它看似冷静但判断精准。
- **描边**：整体深色/黑色描边。
- **动态感**：完全静止，不需要任何动作线条或姿态暗示，强化"在算，没在动"的感觉。

### 风格提示词草稿
```
A round plump owl in a still standing pose, front or slight side view, pixel art 
style, 16-bit retro game sprite, wings folded close to the body, two small ear-tufts 
on top of the head, head slightly oversized relative to body (cartoon proportion), 
cool gray (#8E939C) main body color, dark (#16181B) and gray (#8E939C) horizontal 
color bands on wings and facial disc suggesting feather texture, two oversized 
round eyes taking up nearly half the head with dark near-black (#08090A) solid 
pupils and pale-white (#F2F3F5) eye-rim outline as the dominant visual feature, 
small triangular amber (#FFC53D) beak as the only warm color accent, black outline, 
Greek mythology inspired "the owl of Athena", calm calculating watchful expression, 
completely still pose with no action lines, centered composition, solid dark 
(#08090A) or transparent background, crisp pixel edges, no anti-aliasing, high 
resolution pixel art
```

---

## 7. 角色五：Lazlo（树懒）— 免费领取阵营

### 故事
> 普罗米修斯有个弟弟，叫厄庇米修斯，名字的意思是"后知后觉"。他家门廊底下睡着一只树懒，就是 Lazlo。火从山上下来的时候，Lazlo 在睡觉。火变冷的时候，Lazlo 还在睡。等它终于睁开眼，火已经免费了，所有人都在分。它慢慢伸出手，接到一颗，一分钱没花。它打了个哈欠：「反正最后都是大家的。」但它永远不知道，那颗火星在最烫的时候是什么样子。

### 视觉描述
整体造型要"软"——没有任何尖角，所有轮廓用圆弧表现，**完全静止、松垂的姿态**。

- **形体结构**：四肢短而钝，整体圆润松垂，像挂在树枝上睡觉的姿势（可以画成蜷缩坐姿或半躺姿势）。没有任何尖锐线条，所有边缘都是圆弧。
- **颜色**：身体主色直接用"免费/重生"的青绿色 `#3DDC97`（五个角色里唯一主色对应产品状态色的角色，因为它天然对应"归零免费"状态）。面部和腹部区域用深色 `#16181B` 做色块区分。
- **五官**：眼睛是半闭状态——**不画完整的圆眼睛**，而是画成两条横向的深色短线（像眯眼或打哈欠的表情），这是和其他角色眼睛处理方式最大的不同，直接传达"没睡醒/不着急"的状态。可以加一个小小的半张开的嘴表示打哈欠。
- **描边**：整体深色/黑色描边，但线条要比其他角色更柔和圆润，不要锐利转角。
- **动态感**：双臂抱在胸前或贴着身体自然下垂，不画任何伸手、奔跑或警觉的动态线条——它是五个角色里唯一完全放松、瘫软的姿态。

### 风格提示词草稿
```
A sloth in a relaxed slumped sitting or half-lying pose, pixel art style, 16-bit 
retro game sprite, entirely soft rounded silhouette with no sharp angles anywhere, 
short blunt limbs, arms resting loosely against the body or crossed over the chest, 
main body color in mint-green (#3DDC97) representing "free/reborn" state, dark 
(#16181B) color blocking on face and belly area, half-closed eyes rendered as two 
simple horizontal dark lines instead of round eyes (suggesting drowsy squinting), 
small half-open mouth suggesting a yawn, soft rounded black/dark outline (softer 
than other characters, no sharp corners), Greek mythology inspired "the sloth of 
the late-knowing brother Epimetheus", completely relaxed sleepy unhurried expression, 
no action pose at all, centered composition, solid dark (#08090A) or transparent 
background, crisp pixel edges, no anti-aliasing, high resolution pixel art
```

---

## 8. 交付清单

请为每个角色生成：

1. **待机/正面立绘图**（必需）：按上面每个角色的提示词草稿生成，1024×1024 或更高分辨率，透明或纯黑背景。
2. **Halfie 额外**：如果模型支持多图生成，请额外生成一张"接近归零"状态的 Halfie——同样的形体，但大部分颜色已经变成青绿色 `#3DDC97`，体积明显缩小/变透明，只剩核心几个深灰像素块和那对眼睛清晰可见，表示它即将完全消散重生。

生成后请保留**透明背景 PNG** 格式（如果模型支持），这样可以直接合成到深色网页界面里，不需要再抠图。

每个角色出 2-3 张变体供选择即可，不需要一次生成几十张。

---

## 9. 禁忌清单（一定要避免的方向）

- ❌ 不要 Q 版大头娃娃风格（像 NFT 头像集那种）
- ❌ 不要给任何角色加腮红、爱心眼、星星眼之类的可爱装饰
- ❌ 不要用渐变光晕、玻璃拟态、3D 渲染质感——必须是扁平硬边像素
- ❌ 不要引入调色板之外的颜色（尤其避免粉色、蓝色、红色这类未在色板里出现的颜色）
- ❌ Bolt 不要画成任何生物（没有脸、没有四肢）
- ❌ Halfie 不要画成常见的"火焰精灵"卡通形象（如任天堂风格的小火苗），要更抽象、更像能量体
- ❌ 不要加任何文字、Logo 水印
