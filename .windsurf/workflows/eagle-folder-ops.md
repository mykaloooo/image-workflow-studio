---
description: Eagle 文件夹、导入、关联、标签、注释操作安全分支
---

# Eagle 文件夹操作安全分支

## 适用场景

凡是涉及以下任一动作，必须先执行本分支：

- 查找 Eagle 文件夹、子文件夹、产品文件夹
- 新增 `gen`、产品文件夹、淘汰文件夹
- 导入图片或视频到 Eagle
- 移动图片、让同一图片关联到多个文件夹
- 修改名称、标签、注释、评分
- 删除文件夹、删除 item、清理错误导入
- 处理“Eagle UI 看不到，但 API 说有”的情况

## 0. 操作边界

### 绝对禁止

- 禁止凭截图、文件夹名、图片名猜测目标位置。
- 禁止未确认完整路径和 `folderId` 就导入。
- 禁止把父素材目录、产品成品目录、`gen`、`淘汰 Bad` 混用。
- 禁止直接修改 Eagle library 的 `metadata.json`、`tags.json`、`mtime.json`、`.info/metadata.json`。
- 禁止在未得到卡卡明确确认前删除、批量移动、批量改标签。
- 禁止把 HTTP `/api/item/update` 当作可靠移动、改名、改标签方案。

### 默认原则

- 读操作可以直接做。
- 写操作前先说明路径、ID、动作和预期结果。
- 删除/覆盖/批量移动必须等卡卡确认。
- 非插件环境的 HTTP API 只能做 fallback；插件内优先 Eagle SDK。

## 1. Eagle API 基础

默认地址：

```http
http://localhost:41595
```

优先用 `localhost`，不要随手改成 `127.0.0.1`。

### 1.1 读 Eagle API 的强规则（**终端不卡死**）

**绝对禁止**直接在 PowerShell/Cascade 终端用以下方式读 Eagle API：

- ❌ `curl http://localhost:41595/...`（PowerShell `curl` 是 `Invoke-WebRequest` 别名，大 JSON 会卡）
- ❌ `Invoke-RestMethod` / `Invoke-WebRequest` 直接打印（中文+大 JSON 卡终端）
- ❌ `curl.exe ... | python -c ...`（管道传 1MB+ JSON 给 stdin 也会卡）
- ❌ 任何把响应直接 echo 到终端的方式

**必须**用以下两步模板（永远不会卡终端）：

```powershell
# 步骤1：Python urllib 把响应写到文件（不打印任何响应内容）
python -c "import urllib.request; open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','wb').write(urllib.request.urlopen('http://localhost:41595/api/folder/list', timeout=10).read())"

# 步骤2：单独 python 读文件，只打印需要的字段（输出有上限）
python -c "import json; d=json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8')); print('顶层文件夹数:', len(d.get('data', [])))"
```

写操作（POST/PUT）同理，用 Python：

```powershell
python -c "import urllib.request,json; req=urllib.request.Request('http://localhost:41595/api/folder/create', data=json.dumps({'folderName':'gen','parent':'PARENT_ID'}).encode('utf-8'), headers={'Content-Type':'application/json'}, method='POST'); print(urllib.request.urlopen(req, timeout=10).read().decode('utf-8')[:500])"
```

要点：

- 优先用 `urllib`（Python 标准库永远可用），其次 `httpx`/`requests`。
- 任何打印必须有长度上限（`[:3000]` 或只打几个字段）。
- 不要在 PowerShell 直接 `Invoke-WebRequest`/`Invoke-RestMethod` 读 Eagle API。

### 1.2 验证 Eagle 是否启动

```powershell
python -c "import urllib.request; r=urllib.request.urlopen('http://localhost:41595/api/folder/list', timeout=3); print('Eagle OK, status', r.status)"
```

返回 `Eagle OK, status 200` 即可访问；超时或连接失败说明 Eagle 客户端没启动或端口被占。

## 2. 文件夹定位标准流程

### 2.1 递归读取完整文件夹树

**第一步：把响应写到文件**（不要把响应直接打印到终端）

```powershell
python -c "import urllib.request; open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','wb').write(urllib.request.urlopen('http://localhost:41595/api/folder/list', timeout=10).read())"
```

**第二步：单独 python 读文件，只打印需要字段**

```python
import json
d = json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8'))
all_folders = d['data']  # 顶层是数组，每个元素有 children

# 递归搜索示例（必须把 iconColor 和 icon 字段一起带出来）
def find_folder(folders, target_name, path=''):
    results = []
    for f in folders:
        fp = f"{path}/{f['name']}"
        if target_name in f['name']:
            results.append({
                'id': f['id'],
                'path': fp,
                'iconColor': f.get('iconColor'),  # 必读
                'icon': f.get('icon'),            # 必读
                'children': f.get('children', []),
            })
        if f.get('children'):
            results.extend(find_folder(f['children'], target_name, fp))
    return results

# 用法
hits = find_folder(all_folders, '歌宝婷')
for h in hits:
    mark = []
    if h['iconColor']: mark.append(f"color={h['iconColor']}")
    if h['icon']: mark.append(f"icon={h['icon']}")
    mark_str = f"  [{', '.join(mark)}]" if mark else ''
    print(f"  {h['id']} | {h['path']}{mark_str}")
    for c in h['children']:
        cm = []
        if c.get('iconColor'): cm.append(f"color={c['iconColor']}")
        if c.get('icon'): cm.append(f"icon={c['icon']}")
        cms = f"  [{', '.join(cm)}]" if cm else ''
        print(f"    {c['id']} | {c['name']}{cms}")
```

**汇报格式（必须带颜色+图标）**：

```text
歌宝婷/P1 黑色真皮三人位直排沙发  [color=red]
歌宝婷/P2 米白色真皮 L 型转角沙发  [color=aqua]
歌宝婷/P3 棕褐色真皮超长模块化沙发  [icon=upload]
歌宝婷/P4 深咖色真皮功能头枕三人沙发
```

**列出文件夹内的 item（图片）**：

```python
r = httpx.get('http://localhost:41595/api/item/list', params={
    'folderId': '目标folderId',
    'limit': 100
})
items = r.json()['data']['items']
for item in items:
    print(f"  {item['id']} | {item['name']}.{item['ext']} | {item['width']}x{item['height']}")
    # 本地路径: L:\TUKUbackup\supplies.library\images\{item['id']}.info\{item['name']}.{item['ext']}
```

### 2.2 输出候选路径

定位目标时必须打印：

- 完整路径
- folderId
- 是否有同名/近似名
- 父文件夹 id
- 子文件夹清单

示例格式：

```text
候选 1:
路径: 展商家具 / 2026 / 佛山 / 0320 展会 / 艾狄 沙发 / P3 黑色皮质方块拉扣四人位沙发
folderId: MOVQCJEPJXYGD
父级: 艾狄 沙发(MND4Y2YNHFNFI)
用途: P3 最终成品文件夹
```

### 2.3 同名或不确定时

如果候选超过 1 个，必须停止写操作，只能：

- 列出候选路径和 ID 让卡卡确认；或
- 使用本工作流固定 ID 表中的权威 ID；或
- 通过 item 的现有 folders 反查完整路径确认。

## 3. 沙发项目固定文件夹边界

### 3.1 角色边界

- `艾狄 沙发`：父文件夹，只放原始素材和产品子文件夹。
- `P* 产品文件夹`：只放该产品最终版图片。
- `gen`：临时生成、插件批量回传、测试图，不等于交付。
- `淘汰 Bad`：结构错误、风格错误、历史迭代、被替换版本。

### 3.2 固定 ID 表

| 语义 | folderId |
|------|----------|
| 艾狄 沙发父文件夹 | MND4Y2YNHFNFI |
| P1 黑色皮质金属边 | MOVQ9IQCELCG0 |
| P2 奶油色皮质 | MOVPM34J8K63R |
| P3 黑色方块拉扣 | MOVQCJEPJXYGD |
| P5 灰色拉扣 | MOVSA1GU12PEM |
| P7 深棕色木饰边 | MOVR29RXL70GC |
| 淘汰 Bad | MOVTXAOYJBE8L |

### 3.3 导入目标判定

导入前必须先判断目标语义：

| 目标语义 | 应导入位置 |
|----------|------------|
| 原始参考图 | `艾狄 沙发` 父文件夹或供应商原始素材目录 |
| 最终交付图 | 对应 `P* 产品文件夹` |
| 生成中间图 | 当前任务的 `gen` |
| 错误/淘汰图 | `淘汰 Bad` |
| 供应商侦察缩略图 | 不导入 Eagle，留在本地 outputs |

## 4. 新增文件夹规则

### 4.1 新增子文件夹（完整示例）

```python
import httpx

# 创建子文件夹
r = httpx.post('http://localhost:41595/api/folder/create', json={
    "folderName": "P8 C-1158 黑色皮床",
    "parent": "MND4Y2O64V6E7"  # 父文件夹 ID（供应商文件夹）
})
print(r.json())
# 成功返回: {"status": "success", "data": {"id": "新folderID", "name": "...", ...}}
```

**嵌套子文件夹**：`parent` 指定哪个文件夹，新文件夹就建在哪个下面。

```python
# 例：在 P8 下面建 gen 子文件夹
r = httpx.post('http://localhost:41595/api/folder/create', json={
    "folderName": "gen",
    "parent": "P8的folderId"
})
```

**创建后必须验证**：

```python
# 重新读 folder list，确认新文件夹出现在正确位置
r = httpx.get('http://localhost:41595/api/folder/list')
# 递归搜索确认路径正确
```

### 4.2 重命名文件夹

```python
r = httpx.put('http://localhost:41595/api/folder/update', json={
    "folderId": "目标folderId",
    "newName": "新名称"
})
# 成功返回: {"status": "success"}
```

### 4.3 `gen` 复用规则

- 当前文件夹名已经是 `gen`：直接复用。
- 当前文件夹下已有一级子文件夹 `gen`：复用已有。
- 不存在才新建。
- 禁止生成 `gen/gen`、`gen/gen/gen`。

### 4.4 产品文件夹新增规则

新增产品文件夹前必须：

1. 打印父文件夹完整路径。
2. 列出现有所有 `P*` 产品文件夹。
3. 说明新产品编号、名称、用途。
4. 得到卡卡确认后再创建。

完整示例：

```python
# 1. 先查父文件夹下现有子文件夹
r = httpx.get('http://localhost:41595/api/folder/list')
# 递归找到供应商文件夹，列出 children

# 2. 打印给卡卡确认
# "歌宝婷 (MND4Y2O64V6E7) 下已有: P1, P2, P3, P4, P5, P6
#  要新建: P8 C-1158 黑色皮床"

# 3. 卡卡确认后执行
r = httpx.post('http://localhost:41595/api/folder/create', json={
    "folderName": "P8 C-1158 黑色皮床",
    "parent": "MND4Y2O64V6E7"
})
new_folder_id = r.json()['data']['id']
print(f"新建完成: {new_folder_id}")
```

## 5. 导入图片规则

### 5.1 插件环境优先方案

插件内必须优先：

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

### 5.2 非插件 HTTP fallback

非插件环境可用：

```http
POST /api/item/addFromPath
Content-Type: application/json

{
  "path": "本地图片路径",
  "name": "显示名",
  "annotation": "标注",
  "folderId": "目标folderId"
}
```

注意：

- HTTP `addFromPath` 是**新建一个 Eagle item**，不是给已有 item 加文件夹引用。
- 只允许用于导入本地新产物（如 `products_draft.md`、`contact_sheet_photos.jpg`、最终生成图）。
- 禁止用它把已有 Eagle 原图“分配”到产品文件夹；那会复制一份副本，导致库混乱。
- HTTP 导入可能异步，导入后必须等待并复查。

### 5.3 导入后验证

导入后必须执行双验证：

1. `/api/item/info?id=<itemId>`
2. `/api/item/list?folderId=<targetFolderId>`

验证输出必须包含：

```text
item id:
name:
width:
height:
folders:
目标完整路径:
是否在目标 folderId 的 item/list 中:
```

如果 `item/info` 成功但 `item/list` 看不到，视为未交付成功。

## 6. 同一文件关联到不同文件夹

### 6.1 高风险说明

HTTP `/api/item/update` 历史上对 `folders` 不可靠，可能返回 success 但实际不变。

HTTP `/api/item/addFromPath` 会创建新 item，不是引用。把 Eagle 库里已有图片重新 `addFromPath` 到产品文件夹，会产生副本；副本删除到回收站后，原图仍在，但会造成回收站和库内容混乱。除非卡卡明确同意复制，否则禁止这样做。

### 6.2 允许方案

#### 6.2.1 标准方案：folder-linker 插件引用

引用已有 Eagle 图片到产品文件夹，必须走 `folder-linker` 插件：

```text
插件路径: D:\2026AI\eagle-plugins\folder-linker
队列目录: D:\2026AI\.runtime\folder_link_queue
```

插件只做一件事：

```js
await eagle.item.modify(itemId, { folders: newFolders });
```

效果：

- 原图 item id 不变
- 原图仍保留在供应商父文件夹
- 同一张图同时出现在 `P*` / `01_出图主参考` 等目标文件夹
- 不复制、不移动、不删除、不进回收站

#### 6.2.2 队列文件格式

Python/脚本侧只负责生成 JSON 队列，不直接改 `folders`：

```json
{
  "supplier": "供应商名",
  "tasks": [
    {
      "item_id": "原图 item id",
      "add_folders": ["目标 folderId"]
    }
  ]
}
```

写入：

```text
D:\2026AI\.runtime\folder_link_queue\<timestamp>_<supplier>.json
```

然后确保 Eagle 插件 `文件夹引用 / folder-linker` 正在监听。插件会把任务文件移动到：

```text
D:\2026AI\.runtime\folder_link_queue\done\
```

并生成：

```text
*_result.json
```

#### 6.2.3 引用验证

必须双验证，不能只看插件日志：

```python
# 1. item/info: 原图 folders 必须包含目标 folderId
r = httpx.get('http://localhost:41595/api/item/info', params={'id': item_id})
folders = r.json()['data']['folders']
assert target_folder_id in folders

# 2. item/list: 目标文件夹必须能列出原图 item
r = httpx.get('http://localhost:41595/api/item/list', params={
    'folders': target_folder_id,
    'limit': 100
})
ids = [x['id'] for x in r.json()['data']]
assert item_id in ids
```

验证汇报必须包含：

```text
原图 item id:
原图 name/ext:
原始父 folderId:
目标 folderId:
item/info folders 是否包含目标: true/false
item/list 目标文件夹是否可见: true/false
```

#### 6.2.4 如果误复制了副本

先停止所有 `addFromPath` 复制动作。修复顺序：

1. 用 `folder-linker` 给原图补真实引用。
2. 验证原图 item 的 `folders` 已包含目标 folderId。
3. 生成副本清单，区分：
   - `duplicate_item_id`：误复制出来的新 item
   - `original_item_ids`：原图 item，绝对不能动
4. 得到卡卡明确确认后，只对 `duplicate_item_id` 执行：

```python
httpx.post('http://localhost:41595/api/item/moveToTrash', json={
    "itemIds": duplicate_item_ids
})
```

5. 只进 Eagle 回收站，可恢复；禁止永久删除。

### 6.3 禁止方案

- 禁止只看 `/api/item/update` 返回 success 就宣布完成。
- 禁止把同一 item 是否多文件夹可见当成可靠交付，除非 API 双验证通过且 UI 可见。
- 禁止用 HTTP `addFromPath` 把已有 Eagle 图片导入产品文件夹来冒充“引用”。
- 禁止在未确认 `duplicate_item_id != original_item_id` 前清理副本。
- 禁止清理副本前不验证原图引用已经成功。

## 7. 标签、注释、命名

### 7.1 命名

产品最终图建议格式：

```text
P3 电商主图 正面
P3 电商主图 45度
P3 电商主图 侧面
```

测试图/渠道图建议格式：

```text
P3_omini_4K_test
```

### 7.2 标签

标签写操作必须先列出目标 item id 和原标签。

推荐标签：

- `AI生成`
- `最终版`
- `淘汰`
- `结构问题`
- `风格问题`
- `P1` / `P2` / `P3` / `P5` / `P7`

### 7.3 注释

注释应记录：

- 参考图 item id
- 生成渠道和模型
- 角度
- 是否最终版/淘汰原因

不要把 API Key 写入注释。

## 8. 删除与移动规则

### 8.1 删除 item（移到回收站）

```python
# 把 item 移到 Eagle 回收站（可恢复，不是永久删除）
r = httpx.post('http://localhost:41595/api/item/moveToTrash', json={
    "itemIds": ["item_id_1", "item_id_2"]  # 支持批量
})
# 成功返回: {"status": "success"}
```

### 8.2 移动 item 到另一个文件夹

Eagle HTTP API 的 `/api/item/update` 对 `folders` 字段**不可靠**。已有 Eagle 原图一般不做“移动”，而是做**多文件夹引用**：

- 原图分配到 `P*` / `01_出图主参考`：走第 6 节 `folder-linker` 插件引用。
- 原图仍保留在供应商父文件夹，不复制、不移动、不删除。
- 禁止用 HTTP `addFromPath` 重新导入 Eagle 库里的原图来冒充移动/引用。
- 只有在卡卡明确要求“复制一个独立副本”时，才允许 `addFromPath` 生成新 item，并且必须说明这是复制不是引用。
- 如果需要清理误复制副本，必须按 6.2.4 事故流程：先补真实引用，验证成功，再经卡卡确认只把 `duplicate_item_id` 移到回收站。

### 8.3 删除文件夹

**Eagle HTTP API 不支持删除文件夹。** 只能：
- 在 Eagle 客户端 UI 手动右键删除
- 或者清空文件夹内所有 item 后，文件夹保留为空

如需删除文件夹，告诉卡卡在 Eagle UI 操作。

### 8.4 删除操作的安全流程

默认不删除 Eagle 内容。删除前必须输出：

```text
要删除的对象: item / folder
ID: xxx
名称: xxx
完整路径: xxx / xxx / xxx
影响范围: N 张图 / N 个子文件夹
备份方案: 已移到回收站（可恢复）
回滚方案: 从回收站恢复
```

**必须得到卡卡明确确认后才能执行。**

不得擅自直接改 library JSON 文件。

## 9. UI 看不到时的处理

按顺序排查：

1. `/api/item/info?id=...` 看 item 是否存在。
2. 看 `folders` 是否包含目标 folderId。
3. `/api/item/list?folderId=...` 看目标文件夹是否能列出它。
4. 打印目标 folderId 完整路径，确认是不是用户正在看的文件夹。
5. 如果 API 有、UI 无：让 Eagle 切换文件夹/刷新缓存。
6. 如果路径错：不要移动旧 item，先说明错误，再按正确目标重新导入或等确认后清理。

## 10. 收尾汇报格式

每次 Eagle 写操作完成后必须汇报：

```text
结论：成功/失败/需确认
目标路径：...
目标 folderId：...
item id：...
name：...
尺寸：...
验证方式：item/info + item/list
风险/遗留：...
```

## 11. 文件夹颜色和图标标记（卡卡的语义层）

`/api/folder/list` 返回的每个 folder 节点可能带这两个可选字段。**卡卡用它们给 AI 下指令**，因此读取文件夹时必须带出来。

### 11.1 字段定义

| 字段 | 含义 | 已观测取值 | 备注 |
|------|------|-----------|------|
| `iconColor` | 文件夹颜色标记 | `red` / `blue` / `aqua` | Eagle UI 还支持 yellow/green/purple/pink/orange |
| `icon` | 文件夹符号标记 | `upload` / `lightbulb` / `excalmation` | `excalmation` 是 Eagle 自己拼错的 exclamation，匹配时按这个错拼写 |

- 两个字段可同时存在（例如同时 `iconColor=blue` + `icon=lightbulb`）。
- 字段缺失 = 默认灰色无标记文件夹。

### 11.2 读取代码片段

```python
import json
d = json.load(open(r'D:\2026AI\image-workflow-studio\.runtime\_eagle_probe.json','r',encoding='utf-8'))

def list_marked(folders, parent=''):
    out = []
    for f in folders:
        c, ic = f.get('iconColor'), f.get('icon')
        if c or ic:
            out.append({
                'id': f['id'],
                'path': f"{parent}/{f['name']}",
                'iconColor': c,
                'icon': ic,
            })
        out.extend(list_marked(f.get('children', []), f"{parent}/{f['name']}"))
    return out

for x in list_marked(d['data']):
    parts = []
    if x['iconColor']: parts.append(f"color={x['iconColor']}")
    if x['icon']: parts.append(f"icon={x['icon']}")
    print(f"  {x['id']} | {x['path']}  [{', '.join(parts)}]")
```

### 11.3 语义对照表（由卡卡指定，AI 不要自己揣测）

下表初始为空，卡卡确认每个标记的语义后再填进来。**禁止自行猜测语义并据此执行写操作**，遇到没约定的标记就直接列原始值让卡卡解释。

| 标记 | 语义 | 触发动作 |
|------|------|---------|
| `iconColor=red` | 待卡卡定义 | — |
| `iconColor=blue` | 待卡卡定义 | — |
| `iconColor=aqua` | 待卡卡定义 | — |
| `icon=lightbulb` | 待卡卡定义 | — |
| `icon=excalmation` | 待卡卡定义 | — |
| `icon=upload` | 待卡卡定义 | — |

### 11.4 强约束

- 任何"列出 Eagle 文件夹给卡卡看"的场景，输出**必须包含** `iconColor` 和 `icon` 字段（即使为空也要标明 `[无标记]`）。
- 不要把这两个字段误读成 `color` 或 `iconcolor`，Eagle API 大小写敏感。
- 写文件夹的 API（如 `/api/folder/create`、`/api/folder/update`）目前不支持设置 `iconColor`/`icon`，只能由卡卡在 Eagle UI 里手动右键设置。AI 不要尝试通过修改 library JSON 来改这两个字段。
