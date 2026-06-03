# Eagle 文件夹读写速查

> 新任务接手本项目时，凡是涉及 Eagle 文件夹、子文件夹、批量生成图回传、`gen` 归档，先看本文件。不要再从 `metadata.json` 或猜 API 开始绕圈。

## 1. 当前项目关系

- **Studio 路径**：`D:\2026AI\image-workflow-studio`
- **Eagle 批量生图插件**：`D:\2026AI\eagle-plugins\image-batch-gen`
- **插件调用 Studio**：Eagle 插件负责选图、读取文件夹、提交生成、把结果导回 Eagle；Studio 后端负责 `/api/generate` 和本地 `backend\outputs`。
- **当前同步规则**：本项目 GPT 生图相关改造先只在 PC2 修改验证，未得到卡卡确认前不要自动同步 PC1。

## 2. Eagle API 地址

- **默认地址**：`http://localhost:41595`
- **前提**：Eagle 客户端必须启动，否则 41595 不监听。
- **Windows 踩坑**：优先用 `localhost`，不要随手改成 `127.0.0.1`。历史上 PC1 出现过 `127.0.0.1:41595` 命中 Windows 假 listener 导致 `Server disconnected`，`localhost` 走 IPv6 `::1` 才命中 Eagle。

```js
const EAGLE_API = 'http://localhost:41595';
```

## 3. 读取文件夹树

读取 Eagle 文件夹不要读本地库文件，走 HTTP API：

```http
GET /api/folder/list
```

返回的 `data` 是文件夹树数组，每个节点里用 `children` 放子文件夹。读取子文件夹必须递归 `children`。

### 3.0 终端读取强规则（**别用 curl，会卡终端**）

PowerShell/Cascade 终端读 Eagle API 必须走 Python，不要用 `curl`/`Invoke-WebRequest`/`Invoke-RestMethod`，否则中文+大 JSON 会让终端长时间挂住等输入。

标准两步模板：

```powershell
# 1. 写到文件（不打印响应内容）
python -c "import urllib.request; open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','wb').write(urllib.request.urlopen('http://localhost:41595/api/folder/list', timeout=10).read())"

# 2. 单独 python 读文件，只打印需要的字段
python -c "import json; d=json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8')); print(len(d.get('data',[])), '个顶层文件夹')"
```

详细规则见 `.windsurfrules` 的"读取 Eagle API 的强规则"和 `.windsurf/workflows/eagle-folder-ops.md` 第 1.1 节。

### 3.1 文件夹节点字段

```js
async function fetchEagleFolderTree() {
  const r = await fetch(`${EAGLE_API}/api/folder/list`, { cache: 'no-store' });
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.message || JSON.stringify(j));
  return Array.isArray(j.data) ? j.data : [];
}

function findFolderNodeById(folders, folderId) {
  for (const folder of folders || []) {
    if (folder?.id === folderId) return folder;
    const found = findFolderNodeById(folder?.children || [], folderId);
    if (found) return found;
  }
  return null;
}
```

### 3.2 文件夹标记字段：`iconColor` 和 `icon`（卡卡的语义标记层）

每个 folder 节点可能带这两个**可选字段**，卡卡用它们给 AI 下指令，列出文件夹时必须保留：

| 字段 | 含义 | 已观测取值 |
|------|------|-----------|
| `iconColor` | 文件夹颜色 | `red`、`blue`、`aqua`（Eagle UI 还支持 yellow/green/purple/pink/orange） |
| `icon` | 文件夹符号 | `upload`（上传箭头）、`lightbulb`（灯泡）、`excalmation`（Eagle 把 exclamation 拼错的感叹号） |

字段都缺失 = 默认灰色无标记文件夹；两者可同时存在。

**读取示例**：

```python
import json
d = json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8'))

def list_marked(folders, parent=''):
    out = []
    for f in folders:
        c, ic = f.get('iconColor'), f.get('icon')
        if c or ic:
            out.append((f['id'], f"{parent}/{f['name']}", c, ic))
        out.extend(list_marked(f.get('children', []), f"{parent}/{f['name']}"))
    return out

for fid, path, c, ic in list_marked(d['data']):
    parts = []
    if c: parts.append(f"color={c}")
    if ic: parts.append(f"icon={ic}")
    print(f"  {fid} | {path}  [{', '.join(parts)}]")
```

**约束**：

- 任何"列出 Eagle 文件夹给卡卡看"的场景，输出必须带上这两个字段。
- 写文件夹的 API（`/folder/create`、`/folder/update`）不支持设置颜色/图标，只能由卡卡在 Eagle UI 右键设置。
- 字段大小写敏感：是 `iconColor` 不是 `iconcolor`，是 `excalmation` 不是 `exclamation`。
- 语义对照（red/blue/lightbulb/upload 各代表什么）由卡卡指定，AI 不要自己揣测；详见 `.windsurf/workflows/eagle-folder-ops.md` 第 11 节。

## 4. 读取某个文件夹及所有子文件夹图片

`/api/item/list?folderId=...` 只适合读单个文件夹，不会自动递归子文件夹。要读“当前文件夹 + 所有子文件夹”：

1. `GET /api/folder/list` 拿完整树。
2. 用当前 folderId 找到节点。
3. 递归收集该节点和所有 `children` 的 id。
4. 对每个 id 分别取 item。
5. 用 item id / filePath 去重。

插件内已验证写法在：`D:\2026AI\eagle-plugins\image-batch-gen\logic.js`

关键函数：

- `fetchEagleFolderTree()`
- `findFolderNodeById()`
- `collectFolderIds()`
- `fetchFolderItemsRecursive()`

插件环境里优先用：

```js
const batch = await eagle.item.get({ folders: [folderId] });
```

HTTP fallback 可用：

```http
GET /api/item/list?folderId=<folderId>&limit=200&offset=0
```

## 5. 新建子文件夹

新建文件夹走：

```http
POST /api/folder/create
Content-Type: application/json

{
  "folderName": "gen",
  "parent": "父文件夹ID"
}
```

已验证 JS 写法：

```js
async function createEagleFolder(folderName, parentId) {
  const r = await fetch(`${EAGLE_API}/api/folder/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderName, parent: parentId }),
  });
  const j = await r.json();
  if (j.status !== 'success' || !j.data?.id) {
    throw new Error('创建子文件夹失败: ' + (j.message || JSON.stringify(j)));
  }
  return j.data.id;
}
```

## 6. 找到或创建 `gen` 子文件夹

批量生图的稳定规则：生成结果进入源图所在文件夹下的固定子文件夹 `gen`。

必须避免重复嵌套：

- **如果当前父文件夹已经叫 `gen`**：直接复用当前文件夹。
- **如果父文件夹下已有子文件夹 `gen`**：复用已有 `gen`。
- **否则**：在父文件夹下创建 `gen`。

不要生成 `gen/gen/gen`。

当前已验证实现：`image-batch-gen\logic.js` 的 `ensureGenSubfolder()`。

## 7. 导入图片并挂到文件夹

### 批量生图必须写入完整提示词

批量生图导入 Eagle 时，`annotation` 必须写入完整提示词，作为后续复盘、重跑、排查图文不一致问题的权威依据。

必填内容：

- 任务类型、模型、比例、分辨率
- 源图或参考图
- 完整提示词
- 如果模型实际使用英文提示词，必须同时写中文版对照提示词

不要只把 prompt 存在本地报告、控制台日志、插件任务面板或 TOS 文档里。Eagle item 里没有 prompt，就视为入库信息不完整。

### 插件内优先用 Eagle SDK

历史踩坑：HTTP `/api/item/addFromPaths` 或 `/api/item/addFromPath` 可能接受入库但忽略 `folderId/folders`，导致图片进“未整理区”。

所以在 Eagle 插件内，优先：

```js
const eagleData = await eagle.item.addFromPath(filepath, {
  name: displayName,
  annotation: annotation || '',
  folders: [folderId],
});

const id = eagleData?.id || eagleData?.item?.id || '';
if (id && eagle?.item?.modify) {
  await eagle.item.modify(id, { folders: [folderId] });
}
```

`modify` 是兜底，目的是确保入库 item 真正挂到目标文件夹。

### HTTP 只作为 fallback

非插件环境可 fallback 到：

```http
POST /api/item/addFromPath
Content-Type: application/json

{
  "path": "本地图片路径",
  "name": "显示名",
  "annotation": "标注",
  "folderId": "目标文件夹ID"
}
```

但要知道：HTTP 入库挂文件夹历史上不稳定，插件环境不要优先用它。

## 8. 绝对不要直接改 Eagle 库文件

不要直接改：

- `metadata.json`
- `mtime.json`
- `tags.json`
- `.info/metadata.json`

原因：Eagle 运行时不会可靠重读这些文件，可能造成缓存显示不刷新、数据和客户端状态不一致。文件夹、item、annotation、tags 都优先走 Eagle API / Eagle 插件 SDK。

如果外部同步后 Eagle 显示不刷新，优先在 Eagle 客户端执行“清除缓存并重新加载”。

## 9. 新任务最小排查顺序

1. **确认 Eagle 是否启动**：`http://localhost:41595/api/folder/list` 是否可访问。
2. **确认目标文件夹 id**：从 `/api/folder/list` 递归 `children` 找，不要按名字猜唯一。
3. **读图是否含子文件夹**：如果要包含子文件夹，必须递归收集 folderId 后逐个读。
4. **导入是否挂文件夹**：插件内必须优先 `eagle.item.addFromPath(... folders)` + `eagle.item.modify(... folders)`。
5. **是否重复建 gen**：父文件夹名已经是 `gen` 时直接复用。
6. **不要改本地库 JSON**：任何直接写库文件的方案都先停下。

## 10. 当前权威参考位置

- **本速查**：`D:\2026AI\image-workflow-studio\EAGLE_FOLDER_GUIDE.md`
- **已验证插件实现**：`D:\2026AI\eagle-plugins\image-batch-gen\logic.js`
- **Studio 后端**：`D:\2026AI\image-workflow-studio\backend\app.py`
- **Studio 输出目录**：`D:\2026AI\image-workflow-studio\backend\outputs`
