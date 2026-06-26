# VoiceFox（声狐）AI 外呼平台对接文档

> 本文档提取自一个三平台自动化外呼系统，集中整理了声狐平台的所有对接信息。  
> 将此文档提供给 AI，即可复现声狐外呼的完整功能。

---

## 一、平台信息

| 项目 | 值 |
|------|-----|
| 官网 | https://www.voicefox.cn |
| API 基础地址 | `https://app.voicefox.cn` |
| API 文档 | https://openapi-doc.voicefox.cn |
| 认证方式 | **Cookie/Session**（非 Token/Bearer） |

---

## 二、认证方式

声狐使用 `requests.Session` 进行 Cookie 持久化，登录后服务端返回 `Set-Cookie` 头（`carrot`），后续请求自动携带。

### 2.1 登录

```http
POST https://app.voicefox.cn/api/auth/login
Content-Type: application/json

{
    "email": "your_account@qq.com",
    "password": "your_password"
}
```

**响应示例：**

```json
{
    "email": "xxx@qq.com",
    "phone": "155****8381",
    "displayName": "用户名",
    "lastLogin": "2026-06-24T00:54:36+08:00",
    "profile": {
        "extra": {
            "demoGuideState": "skipped",
            "demoRemainingTimes": 5
        }
    }
}
```

> ⚠️ 登录接口字段名是 `email` 和 `password`，不是 `username`。

### 2.2 获取项目 ID

```http
GET https://app.voicefox.cn/api/profile
```

响应中的 `projects[0].id` 即为当前项目 ID。

---

## 三、核心 API 端点

基本路径：`https://app.voicefox.cn/api/project/{projectId}/`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/login` | 登录 |
| `GET` | `/api/profile` | 获取用户信息及项目列表 |
| `PUT` | `/api/project/{pid}/task` | **创建呼出任务** |
| `POST` | `/api/project/{pid}/task/import_number/{taskId}` | **导入号码（CSV上传）** |
| `GET` | `/api/project/{pid}/task/{taskId}` | 查询任务详情 |
| `GET` | `/api/project/{pid}/task/result_statistic/{taskId}` | 任务呼叫统计 |
| `POST` | `/api/project/{pid}/call_log` | 查询通话记录 |
| `GET` | `/api/project/{pid}/call_log/{sessionID}` | 通话详情 |
| `POST` | `/api/project/{pid}/call_log/{id}/ai_summary` | AI 通话摘要 |
| `GET` | `/api/project/{pid}/call_log_trace_info/{recordId}` | 通话转写/对话记录 |
| `POST` | `/api/project/{pid}/task/filter` | 筛选任务 |
| `PATCH` | `/api/project/{pid}/task/update_status/{taskId}/{status}` | 更新任务状态 |
| `POST` | `/api/project/{pid}/speaker` | 获取可用声音列表 |

### 3.1 创建外呼任务（核心流程）

分为两步：

#### 第 1 步：创建任务

```http
PUT https://app.voicefox.cn/api/project/{projectId}/task
Content-Type: application/json
```

**请求体（精确匹配声狐网页端格式）：**

```json
{
    "name": "任务名称",
    "assistantVid": 42558,
    "category": "assistant",
    "option": {
        "numberFileMeta": { "号码": 0 },
        "numbers": [192],
        "retryCount": 0,
        "retryInterval": 60,
        "smsOption": {
            "isActive": false,
            "sendTiming": { "callHangup": true, "businessStatus": [] },
            "smsSignatureId": 0,
            "smsTemplateId": 0
        },
        "startDate": "2026-06-24",
        "startTime": [["00:01", "23:00"]],
        "taskTimeType": "onetime",
        "taskTransfer": { "target": 0 },
        "weeks": {
            "0": false, "1": false, "2": false,
            "3": false, "4": false, "5": false, "6": false
        }
    }
}
```

| 字段 | 说明 | 示例 |
|------|------|------|
| `name` | 任务名称 | "AI测试" |
| `assistantVid` | AI助理版本ID | `42558`（移动电源外呼AI测试版） |
| `category` | 固定值 `"assistant"` | |
| `option.numbers` | 号码ID列表 | `[192]`（预留位，实际号码通过CSV导入） |
| `option.startDate` | 开始日期 | 当天日期 |
| `option.startTime` | 执行时段 | `[["00:01", "23:00"]]` |
| `option.retryCount` | 重试次数 | `0` |
| `option.retryInterval` | 重试间隔（分钟） | `60` |

**响应示例：**

```json
{
    "id": 14716,
    "name": "任务名称",
    "status": "pending",
    "total": 0
}
```

> ⚠️ `numbers: [192]` 中的 `192` 是声狐系统内部号码ID。实际要呼叫的手机号通过下面的 CSV 导入方式添加。

#### 第 2 步：通过 CSV 导入号码

```http
POST https://app.voicefox.cn/api/project/{projectId}/task/import_number/{taskId}
Content-Type: multipart/form-data
```

**请求体（FormData 格式）：**

| 字段 | 值 |
|------|------|
| file | `numbers.csv`（文本文件，内容为手机号） |

CSV 文件内容示例：

```
13800138000
```

> ⚠️ Content-Type 必须是 `multipart/form-data`，不能是 `application/json`。  
> ⚠️ 需要使用与登录相同的 Session cookie，但**不要**设置 `Content-Type: application/json` 头（让 requests 自动处理 multipart 的 Content-Type）。

**响应：**

```json
{ "count": 1, "message": "upload and parse success" }
```

### 3.2 查询通话记录

```http
POST https://app.voicefox.cn/api/project/{projectId}/call_log
Content-Type: application/json

{
    "offset": 0,
    "limit": 20,
    "taskId": 14716
}
```

> ⚠️ 分页参数使用 `offset` 和 `limit`，**不是** `page` 和 `pageSize`。

**响应关键字段：**

| 字段 | 说明 | 示例 |
|------|------|------|
| `id` | 通话记录ID | `2945650` |
| `callee` | 被叫号码 | `19981964614` |
| `calleeAttribute` | 被叫归属地 | `四川/乐山` |
| `caller` | 主叫号码（线路） | `A068` |
| `direction` | 呼叫方向 | `outbound` |
| `startAt` | 开始时间 | `2026-06-24T12:33:00.477+08:00` |
| `answerAt` | 接通时间 | `2026-06-24T12:33:04.397+08:00` |
| `endAt` | 结束时间 | `2026-06-24T12:33:48.717+08:00` |
| `duration` | 通话时长（秒） | `48` |
| `billsec` | 计费时长（秒） | `44` |
| `hangupReason` | 挂断原因 | `answered`（已接通）/ `no_answer` / `busy` / `failed` |
| `recordFile` | 录音文件路径 | `/records/981/...wav` |
| `task.name` | 所属任务名称 | `返回值测试` |
| `task.summary` | AI通话摘要 | `本次呼叫...` |
| `task.suggestion` | AI建议 | `后续重点关注...` |
| `collect[].items` | AI采集数据 | 产品线、意向度、联系方式 |
| `numberId` | 号码ID | `192` |
| `taskId` | 任务ID | `14741` |

### 3.3 通话详情

```http
GET https://app.voicefox.cn/api/project/{projectId}/call_log/{recordId}
```

返回同 `query_call_logs` 中单条记录的完整信息。

### 3.4 通话转写/对话记录

```http
GET https://app.voicefox.cn/api/project/{projectId}/call_log_trace_info/{recordId}
```

**响应关键字段：**

```json
{
    "traceFile": "CSV下载地址",
    "traceItems": [
        {
            "event": "system.say",
            "content": "您好，我是...",
            "elapsedSeconds": 0
        },
        {
            "event": "user.say",
            "content": "你好",
            "elapsedSeconds": 3
        },
        {
            "event": "hangup",
            "content": "",
            "elapsedSeconds": 48
        }
    ]
}
```

| `event` | 说话方 |
|---------|--------|
| `system.say` | AI |
| `user.say` | 客户 |
| `hangup` | 挂断事件 |

### 3.5 AI 通话摘要

```http
POST https://app.voicefox.cn/api/project/{projectId}/call_log/{recordId}/ai_summary
```

### 3.6 任务统计

```http
GET https://app.voicefox.cn/api/project/{projectId}/task/result_statistic/{taskId}
```

**响应关键字段：**

| 字段 | 说明 |
|------|------|
| `totalNum` | 号码总数 |
| `pendingNum` | 待呼叫数 |
| `callingNum` | 呼叫中 |
| `calledNum` | 已呼叫数 |
| `calledAnsweredNum` | 已接通数 |
| `calledUnAnsweredNum` | 未接通数 |

---

## 四、Python 客户端完整实现

### 4.1 依赖

```python
pip install requests
```

### 4.2 配置格式

```yaml
# config.yaml
voicefox:
  base_url: "https://app.voicefox.cn"
  email: "your_account@qq.com"
  password: "your_password"
```

### 4.3 客户端代码

```python
# voicefox_client.py
import requests
import datetime
import logging

logger = logging.getLogger(__name__)


class VoiceFoxClient:
    """声狐 VoiceFox API 客户端"""

    def __init__(self, config: dict):
        self.config = config
        self.base_url = config.get("base_url", "https://app.voicefox.cn")
        self.project_id = None
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "Accept": "application/json"
        })

    # ------------------------------------------------------------------ #
    # 底层请求
    # ------------------------------------------------------------------ #
    def _request(self, method: str, path: str, **kw):
        """发送 API 请求并解析 JSON 响应"""
        resp = self.session.request(
            method, self.base_url + path, timeout=30, **kw
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text}
        if resp.status_code >= 400:
            raise Exception(
                f"API error {resp.status_code}: {data}"
            )
        return data

    # ------------------------------------------------------------------ #
    # 认证
    # ------------------------------------------------------------------ #
    def login(self) -> dict:
        """
        登录声狐平台。
        登录成功后自动获取 project_id。
        """
        logger.info("Logging in to VoiceFox...")
        result = self._request("POST", "/api/auth/login", json={
            "email": self.config["email"],
            "password": self.config["password"],
        })
        # 获取项目ID
        profile = self._request("GET", "/api/profile")
        projects = profile.get("projects", [])
        if projects:
            self.project_id = projects[0]["id"]
            logger.info(
                f"Logged in as {result.get('displayName', '')}, "
                f"Project ID: {self.project_id}"
            )
        return result

    # ------------------------------------------------------------------ #
    # 创建外呼任务（核心）
    # ------------------------------------------------------------------ #
    def create_task(self, phone: str = "", name: str = None,
                    assistant_vid: int = 42558) -> dict:
        """
        创建外呼任务 + 导入号码。

        流程：
        1. PUT /api/project/{pid}/task 创建任务
        2. POST .../import_number/{taskId} CSV 上传号码

        Args:
            phone: 要呼叫的手机号
            name: 任务名称（默认 auto_{phone}）
            assistant_vid: AI 助理版本 ID

        Returns:
            创建任务的 API 响应
        """
        if not self.project_id:
            self.login()

        today = datetime.date.today().isoformat()
        payload = {
            "name": name or f"auto_{phone}",
            "assistantVid": assistant_vid,
            "category": "assistant",
            "option": {
                "numberFileMeta": {"号码": 0},
                "numbers": [192],
                "retryCount": 0,
                "retryInterval": 60,
                "smsOption": {
                    "isActive": False,
                    "sendTiming": {"callHangup": True, "businessStatus": []},
                    "smsSignatureId": 0,
                    "smsTemplateId": 0,
                },
                "startDate": today,
                "startTime": [["00:01", "23:00"]],
                "taskTimeType": "onetime",
                "taskTransfer": {"target": 0},
                "weeks": {
                    "0": False, "1": False, "2": False,
                    "3": False, "4": False, "5": False, "6": False,
                },
            },
        }
        logger.info(f"Creating task: {payload['name']}")
        result = self._request(
            "PUT",
            f"/api/project/{self.project_id}/task",
            json=payload,
        )
        tid = result.get("id")
        if tid and phone:
            logger.info(f"Importing number: {phone}")
            r = self.import_numbers(tid, str(phone))
            logger.info(f"Import result: {r.get('message', '')}")
        return result

    def import_numbers(self, task_id: int, phone_numbers: str) -> dict:
        """
        通过 CSV 上传方式导入号码到指定任务。

        Args:
            task_id: 任务 ID
            phone_numbers: 手机号（单个或多个，逗号/换行分隔）

        Note:
            必须使用 multipart/form-data 上传。
            直接用 self.session（requests 自动处理 Content-Type）。
        """
        url = (self.base_url
               + f"/api/project/{self.project_id}"
               + f"/task/import_number/{task_id}")
        resp = self.session.post(
            url,
            files={"file": ("numbers.csv", str(phone_numbers), "text/csv")},
            timeout=30,
        )
        return resp.json()

    # ------------------------------------------------------------------ #
    # 查询任务与通话
    # ------------------------------------------------------------------ #
    def get_task(self, task_id: int) -> dict:
        """获取任务详情"""
        return self._request(
            "GET",
            f"/api/project/{self.project_id}/task/{task_id}",
        )

    def get_task_statistics(self, task_id: int) -> dict:
        """获取任务呼叫统计"""
        return self._request(
            "GET",
            f"/api/project/{self.project_id}/task/result_statistic/{task_id}",
        )

    def query_call_logs(self, offset: int = 0, limit: int = 20,
                        task_id: int = None) -> dict:
        """
        查询通话记录（分页）。

        Args:
            offset: 偏移量
            limit: 每页数量
            task_id: 按任务筛选（可选）
        """
        params = {"offset": offset, "limit": limit}
        if task_id:
            params["taskId"] = task_id
        return self._request(
            "POST",
            f"/api/project/{self.project_id}/call_log",
            json=params,
        )

    def get_call_detail(self, record_id: int) -> dict:
        """获取通话详情（含录音文件CDN地址）"""
        return self._request(
            "GET",
            f"/api/project/{self.project_id}/call_log/{record_id}",
        )

    def get_call_ai_summary(self, record_id: int) -> dict:
        """获取 AI 通话摘要"""
        return self._request(
            "POST",
            f"/api/project/{self.project_id}"
            f"/call_log/{record_id}/ai_summary",
        )

    def get_call_trace(self, record_id: int) -> dict:
        """获取通话转写/对话记录"""
        return self._request(
            "GET",
            f"/api/project/{self.project_id}"
            f"/call_log_trace_info/{record_id}",
        )

    def get_call_transcript(self, record_id: int) -> list:
        """
        获取结构化的通话对话记录。

        Returns:
            [{"speaker": "AI|客户|系统", "content": "...", "time": seconds}]
        """
        trace = self.get_call_trace(record_id)
        items = trace.get("traceItems", [])
        result = []
        for item in items:
            event = item.get("event", "")
            content = item.get("content", "")
            seconds = item.get("elapsedSeconds", 0)
            if event == "system.say":
                speaker = "AI"
            elif event == "user.say":
                speaker = "客户"
            elif event == "hangup":
                speaker = "系统"
            else:
                speaker = event
            if content:
                result.append({
                    "speaker": speaker,
                    "content": content,
                    "time": seconds,
                })
        return result

    def filter_tasks(self, params: dict = None) -> dict:
        """筛选任务"""
        return self._request(
            "POST",
            f"/api/project/{self.project_id}/task/filter",
            json=params or {},
        )

    # ------------------------------------------------------------------ #
    # 下载录音与转写
    # ------------------------------------------------------------------ #
    def download_record_file(self, record_id: int,
                             save_dir: str = ".") -> dict:
        """
        下载通话录音 WAV 文件。

        Returns:
            {"file": path, "size": bytes} 或 {"error": "..."}
        """
        import os
        import requests as req

        detail = self.get_call_detail(record_id)
        url = detail.get("recordFile", "")
        if not url:
            return {"error": "no record file"}

        r = req.get(url, cookies=self.session.cookies.get_dict(), timeout=30)
        if r.status_code != 200:
            return {"error": f"download failed: {r.status_code}"}

        os.makedirs(save_dir, exist_ok=True)
        fpath = os.path.join(save_dir, f"call_{record_id}.wav")
        with open(fpath, "wb") as f:
            f.write(r.content)
        return {"file": fpath, "size": len(r.content)}

    def download_trace_file(self, record_id: int,
                            save_dir: str = ".") -> dict:
        """
        下载通话转写 CSV 文件。

        Returns:
            {"file": path, "size": chars} 或 {"error": "..."}
        """
        import os
        import requests as req

        trace = self.get_call_trace(record_id)
        url = trace.get("traceFile", "")
        if not url:
            return {"error": "no trace file"}

        r = req.get(url, cookies=self.session.cookies.get_dict(), timeout=30)
        if r.status_code != 200:
            return {"error": f"download failed: {r.status_code}"}

        os.makedirs(save_dir, exist_ok=True)
        fpath = os.path.join(save_dir, f"trace_{record_id}.csv")
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(r.text)
        return {"file": fpath, "size": len(r.text)}
```

### 4.4 使用示例

```python
import logging
logging.basicConfig(level=logging.INFO)

config = {
    "base_url": "https://app.voicefox.cn",
    "email": "your_account@qq.com",
    "password": "your_password",
}

client = VoiceFoxClient(config)

# 1. 登录
client.login()

# 2. 创建外呼任务 + 导入号码
result = client.create_task(phone="13800138000", name="测试任务")
task_id = result["id"]
print(f"Task created: {task_id}")

# 3. 查询通话记录
logs = client.query_call_logs(offset=0, limit=10)
for item in logs.get("items", []):
    print(f"Call {item['id']}: {item['callee']} -> {item['hangupReason']}")

# 4. 获取通话详情
detail = client.get_call_detail(2945650)
print(f"Duration: {detail['duration']}s, Record: {detail.get('recordFile', 'N/A')}")

# 5. 获取对话记录
transcript = client.get_call_transcript(2945650)
for line in transcript:
    print(f"[{line['time']}s] {line['speaker']}: {line['content']}")

# 6. 下载录音
result = client.download_record_file(2945650, save_dir="./records")
print(f"Saved to {result.get('file', 'failed')}")
```

---

## 五、外呼结果轮询逻辑

创建任务后，需要轮询等待通话完成。从 `call_log` API 的 `hangupReason` 字段判断结果。

### 5.1 状态映射

```python
STATUS_MAP = {
    "answered": "completed",   # 已接通
    "no_answer": "no_answer",  # 无人接听
    "busy": "busy",            # 占线
    "failed": "failed",        # 失败
    "cancel": "failed",        # 取消
    "timeout": "no_answer",    # 超时
}
```

### 5.2 轮询逻辑

```python
import asyncio
import time

async def wait_for_call_result(client: VoiceFoxClient,
                                task_id: int = None,
                                session_id: int = None,
                                max_wait: int = 120,
                                poll_interval: int = 10) -> dict:
    """
    轮询等待通话完成。

    Args:
        client: VoiceFoxClient 实例
        task_id: 任务 ID（通过 get_task 轮询）
        session_id: 通话记录 ID（通过 get_call_detail 轮询）
        max_wait: 最大等待秒数
        poll_interval: 轮询间隔秒数

    Returns:
        {"status": "completed|no_answer|busy|failed",
         "duration": 秒数,
         "recording_url": "...",
         "note": "AI摘要"}
    """
    result = {
        "status": "unknown",
        "duration": 0,
        "recording_url": "",
        "note": "",
    }

    start_time = time.time()
    while time.time() - start_time < max_wait:
        await asyncio.sleep(poll_interval)

        try:
            # 方式1: 通过任务详情获取
            if task_id:
                detail = client.get_task(task_id)
                status = _extract_call_status(detail)
                if status:
                    result = _build_call_result(detail, status)
                    if status in ("completed", "failed", "no_answer", "busy"):
                        break

            # 方式2: 通过通话记录获取
            if session_id:
                detail = client.get_call_detail(session_id)
                status = _extract_call_status(detail)
                if status:
                    result = _build_call_result(detail, status)
                    if status in ("completed", "failed", "no_answer"):
                        break

        except Exception as e:
            logger.warning(f"Poll error: {e}")

    return result


def _extract_call_status(data: dict) -> str:
    """从 API 响应中提取通话状态"""
    # 方式1: 通话详情 - hangupReason
    reason = data.get("hangupReason", "")
    if reason:
        reason = reason.lower().strip()
        mapping = {
            "answered": "completed",
            "no_answer": "no_answer",
            "busy": "busy",
            "failed": "failed",
            "cancel": "failed",
            "timeout": "no_answer",
        }
        return mapping.get(reason, reason)

    # 方式2: 任务详情 - status 字段
    task_status = data.get("status", "")
    if task_status:
        task_status = task_status.lower()
        task_map = {
            "completed": "completed",
            "running": "calling",
            "pending": "pending",
        }
        return task_map.get(task_status, "")

    return ""


def _build_call_result(data: dict, status: str) -> dict:
    """用声狐 API 实际返回字段构建通话结果"""
    return {
        "status": status,
        "duration": data.get("duration", 0) or data.get("billsec", 0),
        "recording_url": data.get("recordFile", "")
                        or data.get("recordUrl", ""),
        "note": (
            (data.get("task") or {}).get("summary", "")
            or (data.get("task") or {}).get("suggestion", "")
            or data.get("result", "")
        ),
    }
```

---

## 六、注意事项

### 1. 号码列表 ID

`numbers: [192]` 中的 `192` 是声狐系统中已存在的号码ID。如果从零开始对接：

- **方式 A**：先在声狐网页端上传号码，获取列表ID
- **方式 B**：先创建任务（`numbers: []`），再通过 CSV 导入号码，系统会自动分配ID

### 2. 演示模式限制

新账号有 5 次演示呼叫额度（`demoRemainingTimes`）。超出后需要购买套餐。

### 3. 并发限制

当前项目配置 `concurrentCallOutTotal: 1`（每次只能同时外呼 1 路）。

### 4. 呼叫未接通的可能原因

- 被叫号码是声狐账号绑定号码（系统可能限制自呼）
- 号码格式不正确（建议使用 `+86` 前缀）
- 演示额度已用完
- 呼出线路未正确配置

### 5. 录间文件的下载

`recordFile` 返回的是相对路径（如 `/records/981/xxx.wav`），需要拼接 CDN 地址或使用 Cookie 认证后下载。示例中的 `download_record_file` 方法使用 session cookies 直接下载。

### 6. CSV 上传注意事项

- Content-Type 必须是 `multipart/form-data`
- 需要使用已登录的 session cookie
- 不要手动设置 `Content-Type` 头，让 `requests` 自动处理
- CSV 内容即手机号文本，无需 CSV 表头

---

## 七、完整流程时序

```
Client                     VoiceFox API
  |                            |
  |-- POST /api/auth/login --> |
  |<-- Set-Cookie: carrot ---- |
  |                            |
  |-- GET /api/profile ------> |
  |<-- {projects[0].id} ------ |
  |                            |
  |-- PUT /api/project/{id}/task -->|
  |<-- {id: taskId} ---------- |
  |                            |
  |-- POST .../import_number/{taskId} (CSV) -->|
  |<-- {count: 1, message: "ok"} |
  |                            |
  |-- POST /api/project/{id}/call_log (轮询) ->|
  |<-- {items: [{...}]} ------ |
  |  (等待 hangupReason != null) |
  |                            |
  |-- GET .../call_log/{id} ->|
  |<-- {hangupReason, recordFile, duration} |
  |                            |
  |-- GET .../call_log_trace_info/{id} ->|
  |<-- {traceItems: [...]} --- |
  |                            |
  |-- GET recordFile (下载) ->|
  |<-- WAV audio ------------- |
```
