# Magpie UI 与交互研究：精致感从哪里来，Lynse 可以学什么

研究日期：2026 年 11 月 5 日  
研究对象：[yetone/magpie](https://github.com/yetone/magpie)，源码固定在 [6abacd46](https://github.com/yetone/magpie/tree/6abacd46c3433f811b32d72c3bfe7a49e78b3d87)  
对照对象：Lynse desktop 当前工作区，HEAD 为 4dc303cc；主要检查共享 UI、聊天页、工作区任务状态和桌面窗口材质。  
交付范围：研究与改进建议。本次只新增文档。

后续实施：[Lynse 布局与交互优化记录](/Users/lynse/Documents/lynse-app/lynse-desktop/docs/design/ui-interaction-polish-2026-11-05.md)。第 6–7 节保留研究时、实施前的基线。

## 1. 核心结论

**Magpie 最值得学习的，是把统一的视觉规则、连续的空间关系和稳定的操作状态贯彻到细节中。**

从已查看的官方展示看，它的界面有很强的整体性：背景安静，同类信息对齐，控件的位置可预测，颜色主要承担识别与状态表达。源码进一步显示，它对动画的起点、终点、中断、异步重绘，以及滚动和焦点保留都有专门实现。

这可以分成五层：

| 层次 | 用户感受到什么 | 背后的工作 |
| --- | --- | --- |
| 任务结构 | 第一眼知道看什么、改什么 | 默认页面围绕主任务组织，次要内容逐步展开 |
| 视觉秩序 | 干净、容易扫读 | 表面层级、列对齐、字体层级、光学尺寸一致 |
| 空间连续 | 控件像同一件物体在移动 | 从触发器展开，关闭回到来源，半途中可以改方向 |
| 状态稳定 | 操作过程中不被打断 | 保存和加载不重演入场、不丢焦点、不抢阅读位置 |
| 工程约束 | 长期迭代后仍然完整 | 体验规则、逐帧回归检查、丰富数据下的截图与录屏 |

**Lynse 已有实现这些体验的主要技术条件。** 我们已有字体、语义颜色、玻璃材质、原生 macOS 背景、按钮按压、动效 tokens 和 Motion。源码对照更支持一个改进方向：提高这些规则在业务页面中的一致性，并补齐完整操作过程的收尾。

这里没有给两款产品打“谁全面更好”的分数。Magpie 默认 Agents 页主要围绕连接与选模型；Lynse 的录音、转写、阅读、编辑、知识管理承担不同复杂度。合理的比较单位应是同类控件和一条完整任务流程。

## 2. 研究证据与边界

| 证据类型 | 本次检查内容 | 能支持的结论 |
| --- | --- | --- |
| 官方可见展示 | 使用 ego-browser 查看官网、Agents 浅色截图、模型选择器深色截图 | 静态布局、信息层级、颜色和控件结构的观察 |
| Magpie 实现 | app.css、app.js、theme/fonts/layout、窗口与面板代码 | 动效参数、状态保持、原生与 WebView 如何配合 |
| 项目约定与测试 | code-standards、gui-shell、交互测试、UI preview 工作流 | 项目如何定义和检查体验；测试存在不代表本次运行通过 |
| Lynse 实现 | tokens、字体、Button、窗口材质、聊天与转写状态 | 已有能力、实现分歧、值得实机核查的改进点 |

未运行 Magpie 原生应用，也未启动 Lynse 做同环境对照；未测帧率、输入延迟、CPU/GPU、真实对比度或屏幕阅读器。因此，下文的“为什么显得精致”是官方展示与源码机制共同支持的分析，性能和运行体验不作实测背书。

官网展示是访问时的线上内容；以下嵌图和源码链接固定到研究提交，以便后续复查。

## 3. 从两张界面看视觉秩序

### 3.1 主页面：对齐和层级先于装饰

![Magpie 官方 Agents 浅色界面](https://raw.githubusercontent.com/yetone/magpie/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/site/public/img/agents-light.png)

图源：[Magpie 仓库的官方截图](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/site/public/img/agents-light.png)。

这张界面最突出的并不是复杂特效，而是几个稳定的关系：

- 每行都按“图标 → 名称与状态 → 模型操作 → 开关”阅读，控件和箭头共享对齐线。
- 一整组内容共享一个白色容器；行间分隔很轻，没有每行再套一张厚重卡片。
- 名称、说明、状态各有层级；彩色 logo 提供快速识别，其余界面保持中性。
- 不常用的 Agent 可以折叠，默认内容优先服务当前任务。
- 操作区有统一形状与背景，用户能分辨哪些可点、哪些是内容。

这说明“精致”首先是让每个元素的位置和重量有理由。单独把圆角调大、阴影调浓，不能替代这种秩序。

源码里，主窗口行高至少 48px，logo 为 22px；标题用 500 字重，说明文字为 11.5px。模型操作区使用共享网格，窄于 600px 时移到下一行，避免把名称挤到不可读。[行结构](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L633-L645)、[操作列和窄窗适配](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L863-L919)

### 3.2 模型菜单：密度高，但层级仍然明确

![Magpie 官方深色模型选择器](https://raw.githubusercontent.com/yetone/magpie/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/site/public/img/picker-dark.png)

图源：[Magpie 仓库的官方截图](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/site/public/img/picker-dark.png)。

它用左侧图标栏、搜索框、供应商分组、模型名称、辅助说明和选中勾号，把大量选项拆成可扫读的结构。紫色集中在焦点、选择和识别信息上；背景、边界、阴影共同交代浮层位置。

值得学的是“同屏信息多时仍有主次”。对 Lynse 的模型菜单、录音筛选、引用选择，也应先确定分组与选中关系，再考虑增加视觉效果。

## 4. 为什么这些细节能叠加成精致感

### 4.1 表面、颜色和字体有稳定分工

Magpie 的基础样式直接写明 quiet surface。它把背景、卡片、展开区、控件、浮层和文字层级分别定义为变量。浅色背景接近灰白，卡片为白色，控件略深；深色主题重新安排层次，而不是仅给整个界面加黑色滤镜。[表面与主题变量](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L1-L106)

其字体默认采用平台系统栈；正文基准为 13px/1.4，并区分普通 UI 字体与等宽内容。数字部分使用等宽数字，减少数值更新时的横向晃动。[字体基准](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L114-L142)、[数字样式示例](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L919)

还有一个很具体的光学校正：相同图标盒中，实心底板的 logo 会缩到 82%，避免它比细线 logo 显得更大、更重。精致感需要的是视觉重量一致，不能只检查元素是否都写了 16px。[图标光学校正](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L178-L191)

**对 Lynse 的启发：** 用现有 tokens 定义清楚内容、输入、浮层的角色；同时检查真实中英混排、数字和图标的视觉重量。没有必要因此更换我们现有的 Inter 与 OPPO Sans。

### 4.2 主动消除“页面一动就抖一下”

Magpie 为页面预留滚动条所需空间，展开内容时不会因为滚动条出现而让整页突然变窄。它还阻止 flex 布局把固定高度内容挤小，并让不同主页面在大窗口中共享约 1200px 的内容跨度。[布局稳定规则](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L569-L605)

这些处理不容易在一张截图里成为亮点，却会在每次展开、收起、刷新和改变窗口尺寸时发挥作用。

**对 Lynse 的启发：** 先检查章节展开、摘要加载、历史抽屉、分栏调整是否改变用户正在看的位置。用稳定的布局减少意外位移，通常比给位移再加一层动画更有效。

### 4.3 动效解释“从哪里来、到哪里去”

Magpie 并非把所有组件套成一个弹簧。它有共同基调，也有按场景调整的参数：

| 场景 | 源码中的处理 | 值得学的原则 |
| --- | --- | --- |
| 常见按钮 | 多类控件约 160ms 反馈，按下缩到 0.96；部分图标另有规则 | 轻量反馈，区分对象 |
| 菜单 | 从触发器方向以 6px 位移、0.94 缩放展开；透明度 180ms、形变 420ms；退出 220ms | 来源明确，快速可见，柔和落定 |
| 分段选择滑块 | 280ms，并从屏幕上当前的位置继续 | 同一件物体连续移动 |
| 来源明确的弹窗 | 从触发器形状展开，570ms spring；透明度单独处理 | 用空间关系解释进入 |
| 侧栏布局切换 | 320ms ease-in-out，页面与导航协同变化 | 大范围变化维持结构关系 |

依据：[按钮反馈](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L4008-L4023)、[菜单](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L2257-L2279)、[滑块](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L9014-L9099)、[弹窗](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8921-L8939)、[侧栏形变](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css#L529-L565)。

尤其值得注意的是，侧栏的注释记录了为何改用较平缓的起步：WebView 丢失开始几帧时，起步太快会显得猛跳。它在根据实际问题调整运动，而不是机械坚持某条曲线。

**对 Lynse 的启发：** 优先统一同一次空间变化的时长和曲线。我们的高频页面不必照搬 570ms，更应沿用现有动效体系，根据距离、频率与任务选择参数。

### 4.4 动画中途再点击，也有合理结果

Magpie 的编辑器高级选项在展开到一半时再次点击，会读取当前高度和透明度，取消旧动画，然后从当前画面反向。内部内容和外层弹窗共用运动曲线，避免内外不同步。[可反向折叠](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L7892-L7950)

关闭仍在展开的弹窗时，也会先保留当前动画状态，再往来源收回；结束后归还焦点。[关闭与回焦点](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8961-L9009)

这解释了“跟手”的一部分来源：用户可以在过程中改变主意，界面仍能接住操作。

**对 Lynse 的启发：** 验收不应只看“点一次能展开”。还要看快速开关、展开中切换目标、请求未结束就关闭，以及失败后返回是否连贯。

### 4.5 异步更新保持安静：不把回包当成重新入场

这是本次研究中最值得学习的一点。

Magpie 的 openModal 区分首次打开、内容切换和安静重绘。重新绘制时会保存正文和嵌套列表的滚动位置，尝试按 id、可访问名称或控件位置找回焦点；只有首次打开才执行完整入场。用户开始操作后，还优先保持正在操作的位置。[弹窗重绘和位置保持](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8815-L8939)

分段选择器也会复用原有滑块及进行中的动画，保存回包不应把滑块重置到旧位置。[滑块身份与当前状态](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L9014-L9099)

用户因此感受到的是“数据更新了”，而不是“我刚才操作的界面又出现了一次”。

**对 Lynse 的启发：** 在录音详情、摘要编辑、模型选择中，关注数据刷新是否重建正在操作的组件；保持稳定的组件身份、局部更新、滚动位置、输入内容和焦点。TanStack Query 与 React 完全可以实现这些目标。

### 4.6 阅读位置被当作用户状态来保护

Magpie 的代码标准明确要求点击不引起意外滚动。实现中，显式导航滚动需要携带近期可信用户事件，并区分用户滚动与重绘造成的移动。[GUI 约定](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/docs/code-standards.md#L195-L201)、[滚动意图机制](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L22620-L22658)

学习这个目标很有价值，但不宜直接复制它复杂的全局滚动拦截器。录音时间定位、聊天自动跟随、键盘导航、搜索结果跳转都有合理的滚动需求。

**对 Lynse 更合适的规则：** 用户没有要求换位置时保留阅读锚点；明确要求跳转时准确滚动。先通过局部布局、正确的滚动容器和焦点管理实现。

### 4.7 原生感来自窗口与网页之间的配合

Magpie 使用 Wails v3，主界面仍是 HTML/CSS/JavaScript。源码没有支持“它因为全原生所以天然更精致”的解释。[宿主实现](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/app.go#L17-L20)、[主界面实现](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L1)

它的 macOS 托盘面板变高时，顶部保持固定，底边移动；原生窗口与网页共享时间和曲线。窗口先长大、WebKit 晚绘制一两帧时，底层原生颜色会承接新出现的边缘，避免露出不一致的背景。[面板高度与底色](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/glide_darwin.go#L28-L95)

刷新图标的结束也单独处理：结果更新后，让旋转走完当前一轮再停止，避免直接移除动画造成瞬间归零。[刷新收尾](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L23341-L23363)

这些细节说明，完成状态和最后一帧也属于设计范围。

**对 Lynse 的启发：** 我们已经有 NSVisualEffectView；下一步应检查窗口尺寸变化、背景边缘、焦点归还、上传与转写完成时的衔接。

### 4.8 第一帧、闲置成本与错误恢复也参与质感

Magpie 在主脚本之前应用主题、字体、字号和窗口模式，减少“先画一种样子再修正”的过程。导航指针效果在需要时加载，稳定后停止逐帧循环；滚动辅助也按需加载、合并事件。[主题](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/theme.js)、[字体](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/fonts.js)、[布局](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/layout.js)、[导航效果](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/navlamp.js)

它对核心首屏脚本设字节预算，推动功能按需拆出。这个预算排除了翻译和插件脚本，不代表整个前端只有约 1.5MB，也不能替代性能实测。[脚本预算检查](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/core_budget_test.go#L22-L50)

插件页面出错时，有局部错误边界和 Try again；其他页面继续可用。[局部错误恢复](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/kernel.js#L60-L124)

**对 Lynse 的启发：** 把“第一次打开就正确”“等待时仍有结构”“失败后有下一步”一并纳入界面质量。

## 5. 精致感如何在迭代中保留下来

Magpie 的测试不只问“这个按钮有没有效果”，还检查动作过程：

| 体验规则 | 已阅读的测试如何检查 |
| --- | --- |
| 滑块不因保存回包而闪回 | 逐帧检查移动方向、其他控件是否静止，以及保存失败的回退 |
| 异步内容不让弹窗重新闪入 | 检查透明度维持 1、顶部变化小于 0.5px，以及滚动和焦点保留 |
| 收起列表与行开关时，指定阅读锚点不漂移 | 记录动作期间指定锚点的位置，约束漂移不超过 2px；Show more 则允许按钮随内容合理移动 |

依据：[segs-glide](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/tests/segs-glide.test.cjs#L78-L190)、[editor-quota-quiet](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/tests/editor-quota-quiet.test.cjs#L113-L141)、[panel-fold](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/tests/panel-fold.test.cjs#L43-L61)。这些是测试断言，不是本次实测结果。

其代码标准要求相关 GUI 改动在 Chromium、WebKit 和多语言环境验证，并明确该 GUI 套件当时需本地运行。另有 PR 预览工作流：准备丰富模拟数据，生成截图，必要时录制操作视频。[验证要求](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/docs/code-standards.md#L74-L88)、[UI preview](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/.github/ui-preview/README.md#L1-L32)

**值得借鉴的是把体验变成可见、可复查的验收材料。** 不需要照搬其整套录屏规划工具；先为我们最重要的流程保留少量有意义的检查即可。

## 6. 对照 Lynse：我们已经具备什么

| 基础能力 | 当前实现 | 研究判断 |
| --- | --- | --- |
| 语义颜色、圆角、阴影、动效 | [tokens.css](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/tokens.css:64) | 已有体系，应优先提高业务页面复用程度 |
| 中英文字体 | [fonts.css](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/fonts.css:13) | Inter 与 OPPO Sans 可变字体；需要在真实内容中评估字重与密度 |
| 按钮触感 | [button.tsx](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/components/ui/button.tsx:8) | 已有 150ms、0.96 按压、焦点和禁用状态 |
| 两级玻璃浮层 | [tokens.css](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/tokens.css:309) | 已有深浅主题与透明度回退，无需靠增加 blur 作为首要改进 |
| macOS 原生材质 | [window_effects.rs](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src-tauri/src/window_effects.rs:58) | 主窗已有 Sidebar 材质，录音岛有 Popover 材质 |
| 状态和性能基础 | [chat-activity.tsx](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/chat-activity.tsx:8)、[resizable-handle.tsx](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/resizable-handle.tsx:28) | 已有共享活动状态、拖动帧合并等能力 |

主题切换抑制过渡、统一 Lucide 描边和 CSS 减少动态回退也已经存在。研究建议不应把这些写成“需要从零补齐”的功能。[主题](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/components/common/theme-provider.tsx:18)、[基础样式](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/base.css:5)、[减少动态](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/ui/styles/base.css:375)

## 7. 最值得优先检查的七个改进机会

以下优先级表示建议实施顺序，全部是源码对照后的机会点；没有把尚未观察到的视觉问题写成已证实缺陷。

| 优先级 | 源码事实 | 建议与验收方向 |
| --- | --- | --- |
| 第一批 | 历史抽屉用 180ms Motion，正文与输入区用 150ms CSS margin，属于同一次空间变化的两套时间轴。[聊天页](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/page.tsx:654) | 统一时长与曲线，检查快速开关时抽屉、正文、输入区是否同步，并保留减少动态分支 |
| 第一批 | 聊天输入框单独声明白色、neutral 焦点边框和多组具体阴影。[输入框](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/page.tsx:863) | 为输入表面补足语义配方；验证深浅主题与焦点层级，不必因此加入玻璃 |
| 第一批 | 工作区重试、转写、生成等操作多处手写 button，拥有各自的尺寸与反馈。[重试](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:1584)、[转写](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:2042)、[生成](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:2082) | 复用共享 Button，或明确增加 variant；统一 hover、按压、焦点、pending、disabled |
| 第二批 | 桌面普通文本继承 300 字重；历史日期使用 10px 元信息样式。[全局字重](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src/globals.css:9)、[历史列表](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/chat-history-sidebar.tsx:73) | 用真实中英内容比较 300/400 与不同元信息字号，按阅读清晰度决定；不能仅据源码断言太细或对比度失败 |
| 第二批 | 聊天、重新摘要、本地转写采用不同活动表现。[聊天](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/chat-activity.tsx:20)、[摘要](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:1560)、[转写](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:1992) | 先统一排队、执行、完成、失败的语义与占位关系，再按任务选择动效 |
| 第二批 | 重新摘要错误组件有恢复按钮；另一摘要错误组件自身只展示标题和说明。[恢复状态](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:1570)、[另一错误状态](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/workspace/content-panel.tsx:1611) | 实机确认用户能否就地发现下一步。页面其他位置可能已有入口，不能据此判断无法恢复 |
| 第二批 | 桌面最小宽度为 560px，历史栏固定 224px，打开时内容整体让位。[窗口](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/src-tauri/tauri.conf.json:20)、[历史栏](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/chat/page.tsx:662) | 在最小窗口、长中文、长英文和放大字体下验收；空间不足时评估覆盖显示或自动收起 |

这些点的共同方向是：让已有规则从组件层贯穿到业务流程，减少每个页面各自再设计一套的情况。

## 8. 建议怎么学，哪些不要直接复制

### 8.1 建议实施顺序

**先做一个完整样板。** 选择聊天历史抽屉，或“录音列表 → 详情 → 摘要/章节 → 编辑 → 关闭”这条流程。前者便于集中验证空间变化，后者能覆盖阅读位置、异步更新、焦点和错误恢复。

第一步，收敛视觉配方：统一内容、输入、浮层的角色，复用按钮与菜单，整理行结构和对齐。

第二步，完成状态转换：首次打开、加载回包、刷新、失败、重试、关闭分别处理；保留当前内容、焦点和滚动锚点；同一次空间变化共用时间轴，支持中途改变方向。

第三步，建立验收样本：用真实密度的长内容、慢响应、失败、快速连点、窄窗和键盘路径检查。保留一段短录屏，并只为关键行为增加必要回归测试。

第四步，再加入少量品牌表达：优先放在低频、值得关注的时刻，避免增加高频操作的等待。

按仓库现有边界实施：纯视觉组件与配方进入 packages/ui，业务状态留在 packages/views，服务端状态仍由 TanStack Query 管理，原生窗口行为留在 apps/tauri。不需要为学习 Magpie 引入另一套架构。

### 8.2 不宜直接复制的部分

| Magpie 做法 | 为什么需要判断 |
| --- | --- |
| 手写 DOM、无框架主脚本 | 这不是精致感的必要条件；Lynse 应继续使用现有 React、Base UI 与 Motion |
| 全局禁止意外滚动的复杂机制 | 有较重的浏览器兼容成本；应先实现局部阅读锚点保护 |
| 较长 spring 与逐行进入 | 适合部分低频结构变化，不能覆盖所有高频点击 |
| 全界面主题渐变 | Magpie 有意采用 350ms 渐变；Lynse 已有主题切换抑制过渡，可保留现有策略 |
| 统一透明材质 | Magpie 也会为绘制稳定性放弃部分平台的透明；材质应服从实际渲染质量 |
| 为品牌动画延后显示内容 | 骨架鸟出现后，部分读取会等待落脚完成，注释约 1.6 秒，最长 3 秒；不适合直接用于 Lynse 高频阅读与转写 |

最后一项有明确实现依据：[等待机制](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8562-L8573)、[超时释放](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8595-L8599)。这属于品牌表现与速度之间的取舍，不能称作速度优化。

同样，Magpie 虽有系统与应用层的减少动态开关，仍不能据此假设所有 Web Animations 路径都已完整降级。本次没有进行这项实机验收。[减少动态判断](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L8532-L8536)、[滑块路径](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js#L9073-L9099)

## 9. 后续验收应看什么

| 场景 | 可观察的合格表现 |
| --- | --- |
| 正常打开 | 立即反馈；内容与控件来源清楚 |
| 动画中再次操作 | 从当前画面继续，或合理反向，无位置闪回 |
| 慢请求返回 | 已有内容保持稳定，不重演入场，不丢输入和焦点 |
| 用户正在阅读 | 刷新、展开不意外抢走位置；主动跳转则准确定位 |
| 保存失败 | 失败位置明确，保留输入，提供可发现的恢复路径 |
| 关闭弹层 | 收尾自然，焦点返回合理位置 |
| 窄窗与长文字 | 主要内容和操作仍可到达，必要时改变布局 |
| 键盘与减少动态 | 功能完整，状态不依赖运动才能理解 |
| 空闲或隐藏窗口 | 无需工作的效果停止，关键状态仍然可见 |

我们真正应该建立的是这套可重复的质量判断。这样，精致感才会在更多页面和后续迭代中稳定出现。

## 10. 后续阅读入口

- [主样式：视觉层级、布局和动效](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.css)
- [主交互：弹窗、滑块、滚动和状态收尾](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/app.js)
- [GUI 子系统说明](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/docs/subsystems/gui-shell.md)
- [代码标准与 GUI 验收要求](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/docs/code-standards.md)
- [原生面板尺寸和底色配合](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/glide_darwin.go)
- [UI 预览流程](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/.github/ui-preview/README.md)
- [交互测试说明](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/tests/README.md)

本次验证记录：读取上述固定提交的公开源码与相关测试；查看官方静态界面；对照 Lynse 当前源码。未运行两款应用的交互测试或构建，也未进行同环境性能、无障碍与完整流程实测。

## 11. 补充研究：让更新说明变得清楚

依据：用户提供的更新确认弹窗截图，以及 Magpie 的 [whatsnew.js](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/whatsnew.js)。此节记录呈现与文案规范；分类展示和阅读布局现已接入 Lynse 本地代码，详见[实现记录](/Users/lynse/Documents/lynse-app/lynse-desktop/docs/design/ui-interaction-polish-2026-11-05.md)。

### 11.1 为什么这份说明容易读

| 做法 | 对用户的价值 |
| --- | --- |
| 标题直接给出目标版本，旁边说明从哪个版本开始比较 | 明确这次升级与自己的关系 |
| 把跨版本变化合并成“新功能、改进、错误修复”等类别 | 不必逐个翻阅中间小版本 |
| 分类标题带条目数 | 快速判断内容量，按兴趣选择阅读 |
| 每条讲一个可感知变化 | 能理解自己升级后具体得到什么 |
| 版本号放在条目后，用较弱的视觉层级 | 保留追溯能力，同时让变化本身成为主角 |
| 正文留出足够宽度，列表换行对齐文字起点 | 长句仍能扫读，不会变成密集文本墙 |
| 操作区与正文分开，底部始终可达 | 阅读说明与执行更新分别有明确位置 |

它的文字也有一套可学习的顺序：先说功能或问题，再交代变化后的行为，需要时才补充条件。例如，“修复某状态显示错误，现在正确显示为某状态”，比“优化显示逻辑”更有用。

### 11.2 源码里有意实现的机制

- mergedNotes 将多个版本按类别合并，同类完全相同的条目去重，每条保留版本号，类别按固定顺序展示。
- noteBlocks 识别标题、列表、段落以及有限的行内格式，使用文本节点构建说明。
- confirmUpdate 先展示已有的目标版本说明，再异步补入中间版本记录；返回时检查弹窗是否仍是原来的那个，避免旧请求覆盖新界面。
- 多版本汇总显示实际覆盖范围；服务端仅返回最新一部分时，会明确说明只展示了部分记录。
- 没有说明或读取失败时，提供明确状态、重试或发布页面入口。

以上为源码检查结果，未对截图对应版本进行完整交互实测。[实现来源](https://github.com/yetone/magpie/blob/6abacd46c3433f811b32d72c3bfe7a49e78b3d87/internal/gui/assets/whatsnew.js)

### 11.3 Lynse 当前的差距与数据条件

改造前，[更新弹窗](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/app-update-dialog.tsx) 已有当前与目标版本、下载进度、失败重试和底部操作，但更新说明放在较小的纯文本滚动框里。多条变化缺少真正的分类标题与列表结构，长内容的可扫读性有限。

现有 [更新数据模型](/Users/lynse/Documents/lynse-app/lynse-desktop/packages/views/app-update.ts) 主要承载最新版本说明，没有完整的跨版本记录列表。因此，改造应分两层进行：

1. 先把已有说明按真实标题和条目渲染，提升阅读宽度、行距和分组；未知格式仍保留全文。
2. 在更新源提供完整历史后，再展示“自当前版本以来”的合并说明、类别数量和逐条版本出处。

只拿到最新版本内容时，应明确标注“此版本更新内容”；不能据此声称已经覆盖中间所有版本。目标版本、正文范围和实际条目应一致。

操作文案也要匹配真实阶段。Magpie 的 confirmUpdate 用于下载后的安装确认，按钮写“重启以更新”有相应前提。Lynse 的现有操作还包含下载、校验与安装，不能只因截图清楚就直接替换成相同按钮文字。

### 11.4 建议形成的更新说明规范

- 分类只显示实际有内容的类别，通常按“新功能 → 改进 → 修复”排列；必要时单列安全、兼容性或重要变更。
- 一条一个变化，说明“现在可以怎样做”或“原来遇到什么问题、现在如何表现”。
- 写用户能理解的功能和场景；工程术语只在影响使用选择时出现。
- 同一类别内按版本从新到旧，保留来源版本；条目数按展示内容计算。
- 使用真实标题与列表结构，版本号作为辅助信息；正文可滚动，操作区保持可见。
- 缺少说明、读取失败、历史不完整都应有对应状态。
- 验收跨多版本、长中文与英文、窄窗口、键盘阅读、下载中和失败恢复等情况。

### 11.5 现有 1.3.0 文案的改写示例

以下基于仓库现有内容拆分与归类，已同步写入本地 [1.3.0 发布说明](/Users/lynse/Documents/lynse-app/lynse-desktop/apps/tauri/release-notes/1.3.0.json) 的五种语言版本。尚未上传远端更新源，线上说明仍以已发布内容为准。

**新功能 · 2**

- 录音详情支持 AI 语义章节，云端录音也可使用。
- 新增 Apple 端上语音识别。

**改进 · 2**

- 章节时间统一显示时、分、秒；点击时间定位播放，点击发言人查看对应转写。
- 改进实时会议纪要的保存与显示。

**修复 · 1**

- 超长音频不生成波形时，明确说明原因，避免被误认为处理失败。


