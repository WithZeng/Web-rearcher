# Windows 部署指南

本文档适用于 Windows 10/11，本地部署 `Web rearcher` 项目的前后端开发环境。

## 1. 环境要求

- Python 3.11 或 3.12
- Node.js 20 LTS
- Git
- 可选：Microsoft Visual C++ Build Tools

建议先确认版本：

```powershell
python --version
node --version
npm --version
git --version
```

## 2. 克隆项目

```powershell
git clone <你的 GitHub 仓库地址>
cd "Web rearcher"
```

## 3. 配置 Python 虚拟环境

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

如果 PowerShell 禁止执行脚本，可先运行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 4. 配置前端依赖

```powershell
cd frontend
npm install
cd ..
```

## 5. 配置环境变量

复制示例配置：

```powershell
Copy-Item .env.example .env
```

然后编辑根目录 `.env`，至少填写这些字段：

```env
OPENAI_API_KEY=sk-xxxx
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1

FETCH_CONCURRENCY=15
LLM_CONCURRENCY=5
MAX_RESULTS=50
```

可选配置：

- `UNPAYWALL_EMAIL`
- `IEEE_API_KEY`
- `SCOPUS_API_KEY`
- `NOTION_TOKEN`
- `NOTION_PARENT_PAGE_ID`
- `NOTION_DB_NAME`
- `HTTP_PROXY`

## 6. 启动后端

新开一个 PowerShell 窗口：

```powershell
cd "你的项目路径\Web rearcher"
.venv\Scripts\Activate.ps1
uvicorn api.server:app --reload --host 127.0.0.1 --port 8000
```

后端健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

## 7. 启动前端

再开一个 PowerShell 窗口：

```powershell
cd "你的项目路径\Web rearcher\frontend"
npm run dev
```

浏览器访问：

```text
http://127.0.0.1:3000
```

## 8. 常见问题

### 8.1 `python-multipart` 缺失

如果上传 PDF 时后端报表单解析错误，重新安装依赖：

```powershell
pip install -r requirements.txt
```

### 8.2 PowerShell 无法激活虚拟环境

执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

然后重新打开 PowerShell。

### 8.3 前端端口被占用

可以改用：

```powershell
npm run dev -- --port 3001
```

### 8.4 后端端口被占用

可以改用：

```powershell
uvicorn api.server:app --reload --host 127.0.0.1 --port 8001
```

如果改了端口，前端对应的 API 地址也要调整。

## 9. 生产部署建议

如果要在 Windows 服务器上长期运行，建议：

- 后端用 `uvicorn` 配合 NSSM 或任务计划程序托管
- 前端先执行 `npm run build`，再用 `npm run start`
- 通过 Nginx 或 Caddy 做反向代理
- 把 `.env` 放在服务器本地，不要提交到 GitHub

## 10. 更新项目

```powershell
git pull
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd frontend
npm install
cd ..
```
