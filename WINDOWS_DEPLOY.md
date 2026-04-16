# Windows 部署指南

这份文档按“从零开始部署”来写，适合 Windows 10 / 11 本地开发、测试，或在 Windows 机器上长期运行这个项目。

项目结构分成两部分：

- 后端：FastAPI，默认端口 `8000`
- 前端：Next.js，默认端口 `3000`

你需要同时启动前后端，浏览器才能正常使用。

## 1. 准备环境

建议安装以下软件：

- Python 3.11 或 3.12
- Node.js 20 LTS
- Git
- 可选：Visual Studio Build Tools

先在 PowerShell 里确认版本：

```powershell
python --version
node --version
npm --version
git --version
```

建议参考版本：

- Python: `3.11.x` 或 `3.12.x`
- Node.js: `20.x`
- npm: `10.x`

## 2. 获取项目代码

如果你还没有代码：

```powershell
git clone https://github.com/WithZeng/Web-rearcher.git
cd "Web-rearcher"
```

如果你已经有代码目录，直接进入项目根目录即可：

```powershell
cd "你的路径\Web-rearcher"
```

项目根目录下应该能看到这些内容：

```text
api
frontend
lit_researcher
requirements.txt
.env.example
```

## 3. 创建 Python 虚拟环境

在项目根目录执行：

```powershell
python -m venv .venv
```

激活虚拟环境：

```powershell
.venv\Scripts\Activate.ps1
```

如果 PowerShell 提示不允许执行脚本，先执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

然后关闭当前 PowerShell，再重新打开，重新进入项目目录，再执行：

```powershell
.venv\Scripts\Activate.ps1
```

激活成功后，命令行前面通常会出现：

```text
(.venv)
```

## 4. 安装后端依赖

先升级 `pip`：

```powershell
python -m pip install --upgrade pip
```

再安装依赖：

```powershell
pip install -r requirements.txt
```

这一步会安装：

- FastAPI
- Uvicorn
- PDF 解析依赖
- OpenAI / Anthropic SDK
- `python-multipart`

如果后面 PDF 上传报错，第一时间先重新执行一次这条命令。

## 5. 安装前端依赖

进入前端目录：

```powershell
cd frontend
```

安装依赖：

```powershell
npm install
```

安装完成后回到项目根目录：

```powershell
cd ..
```

## 6. 配置环境变量

在项目根目录，把示例文件复制成真实配置：

```powershell
Copy-Item .env.example .env
```

然后用编辑器打开 `.env`。

最低限度你至少要填写这些：

```env
OPENAI_API_KEY=sk-xxxx
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1

FETCH_CONCURRENCY=15
LLM_CONCURRENCY=5
MAX_RESULTS=50
```

常见可选配置：

- `UNPAYWALL_EMAIL`
  作用：辅助获取开放获取全文
- `IEEE_API_KEY`
  作用：启用 IEEE 检索
- `SCOPUS_API_KEY`
  作用：启用 Scopus 检索
- `NOTION_TOKEN`
  作用：推送结果到 Notion
- `NOTION_PARENT_PAGE_ID`
- `NOTION_DB_NAME`
- `HTTP_PROXY`
  作用：如果你本机必须走代理访问外网，就配置它

注意：

- `.env` 不要上传到 GitHub
- API Key 填错时，后端通常能启动，但提取时会失败

## 7. 启动后端

打开一个新的 PowerShell 窗口，进入项目目录：

```powershell
cd "你的路径\Web-rearcher"
.venv\Scripts\Activate.ps1
```

启动后端：

```powershell
uvicorn api.server:app --reload --host 127.0.0.1 --port 8000
```

如果启动成功，你会看到类似：

```text
Uvicorn running on http://127.0.0.1:8000
```

你可以在浏览器或 PowerShell 测试健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

正常应返回类似：

```json
{
  "status": "ok",
  "uptime_seconds": 12.3,
  "running_tasks": 0
}
```

## 8. 启动前端

再打开第二个 PowerShell 窗口：

```powershell
cd "你的路径\Web-rearcher\frontend"
```

启动前端开发服务：

```powershell
npm run dev
```

启动成功后，打开浏览器访问：

```text
http://127.0.0.1:3000
```

## 9. 最短启动流程

如果你已经安装过依赖，后面每次启动只需要：

第一个终端：

```powershell
cd "你的路径\Web-rearcher"
.venv\Scripts\Activate.ps1
uvicorn api.server:app --reload --host 127.0.0.1 --port 8000
```

第二个终端：

```powershell
cd "你的路径\Web-rearcher\frontend"
npm run dev
```

然后打开：

```text
http://127.0.0.1:3000
```

## 9.1 一键启动脚本

项目根目录现在自带三个 PowerShell 脚本：

- `ensure-environment.ps1`
- `start-backend.ps1`
- `start-frontend.ps1`
- `start-all.ps1`

另外还提供了一个可直接双击的启动器：

- `start-all.bat`

### 只启动后端

```powershell
.\start-backend.ps1
```

### 只启动前端

```powershell
.\start-frontend.ps1
```

### 同时启动前后端

```powershell
.\start-all.ps1
```

或者直接在资源管理器里双击：

```text
start-all.bat
```

运行 `start-all.ps1` 后，会自动弹出两个新的 PowerShell 窗口：

- 一个跑后端
- 一个跑前端

你以后通常只需要执行这一条就够了。

现在脚本会自动做这些事情：

- 如果没有 `.venv`，自动创建
- 如果后端依赖没装，自动执行 `pip install -r requirements.txt`
- 如果没有 `.env`，自动从 `.env.example` 复制
- 如果前端依赖没装，自动执行 `npm install`

也就是说，对多数新机器来说，直接双击 `start-all.bat` 就会先补环境，再启动项目。

如果双击脚本没有权限执行，先运行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 10. 常见问题排查

### 10.1 启动后端时报 `ModuleNotFoundError`

通常有三种原因：

1. 你不在项目根目录
2. 你没有激活 `.venv`
3. 依赖没装完整

解决方式：

```powershell
cd "你的路径\Web-rearcher"
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn api.server:app --reload --host 127.0.0.1 --port 8000
```

### 10.2 上传 PDF 报错

先重新安装依赖：

```powershell
pip install -r requirements.txt
```

重点确认 `python-multipart` 已安装，因为 PDF 上传接口依赖它。

### 10.3 PowerShell 无法激活虚拟环境

执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

然后关闭 PowerShell，再重新打开。

### 10.4 前端打不开，提示端口占用

换个端口：

```powershell
npm run dev -- --port 3001
```

然后访问：

```text
http://127.0.0.1:3001
```

### 10.5 后端端口 8000 被占用

换个端口：

```powershell
uvicorn api.server:app --reload --host 127.0.0.1 --port 8001
```

如果后端改成 `8001`，前端也要知道新的地址。

你可以在启动前端前设置环境变量：

```powershell
$env:NEXT_PUBLIC_API_URL="http://127.0.0.1:8001"
$env:NEXT_PUBLIC_WS_URL="ws://127.0.0.1:8001"
npm run dev
```

### 10.6 前端页面能打开，但检索或提取失败

通常检查这些：

- `.env` 里的 `OPENAI_API_KEY` 是否正确
- `OPENAI_BASE_URL` 是否可访问
- 如果你使用代理，`HTTP_PROXY` 是否配置正确
- 后端终端里是否打印了更详细的异常

### 10.7 第一次安装很慢

这通常正常，因为会下载：

- Python 依赖
- Node 依赖
- PDF 处理相关包

如果网络环境慢，可以考虑配置国内镜像或代理。

## 11. 如何停止服务

在前后端各自的终端窗口里按：

```text
Ctrl + C
```

就可以停止当前服务。

## 12. 更新项目代码

以后更新项目时，建议按这个顺序：

```powershell
git pull
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd frontend
npm install
cd ..
```

然后重新启动前后端。

## 13. 生产部署建议

如果你不是本地调试，而是想在 Windows 机器上长期运行，建议这样做：

- 后端：
  用 `uvicorn` 常驻运行，并用 NSSM 或任务计划程序托管
- 前端：
  用生产模式运行，而不是 `npm run dev`
- 反向代理：
  建议配 Nginx 或 Caddy

### 13.1 前端生产模式

在 `frontend` 目录执行：

```powershell
npm run build
npm run start
```

默认会监听 `3000` 端口。

### 13.2 后端生产模式

在项目根目录执行：

```powershell
.venv\Scripts\Activate.ps1
uvicorn api.server:app --host 127.0.0.1 --port 8000
```

生产环境下通常不建议保留 `--reload`。

### 13.3 使用 NSSM 托管

如果你希望 Windows 开机自动启动服务，可以考虑用 NSSM 把：

- `uvicorn`
- `npm run start`

都注册成 Windows 服务。

## 14. 推荐的部署顺序

如果你现在只是想“最快跑起来”，就按下面做：

1. 安装 Python、Node.js、Git
2. 克隆仓库
3. 创建 `.venv`
4. `pip install -r requirements.txt`
5. `cd frontend && npm install`
6. 复制 `.env.example` 为 `.env`
7. 填入 `OPENAI_API_KEY`
8. 启动后端
9. 启动前端
10. 打开浏览器访问 `http://127.0.0.1:3000`
