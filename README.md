# Web rearcher

一个用于文献检索、DOI 导入、本地 PDF 解析与结构化提取的研究助手项目。

## 技术栈

- FastAPI
- Next.js
- WebSocket 实时进度推送
- 多阶段文献处理流水线

## 功能

- 关键词检索
- DOI 批量导入
- 本地 PDF 上传与提取
- 历史记录与导出
- Notion 集成

## 本地启动

后端：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn api.server:app --reload --port 8000
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

访问：

```text
http://127.0.0.1:3000
```

## 部署文档

Windows 部署说明见 [WINDOWS_DEPLOY.md](./WINDOWS_DEPLOY.md)。
