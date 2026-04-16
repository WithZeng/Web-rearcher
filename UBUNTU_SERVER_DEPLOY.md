# Ubuntu / Debian 服务器部署

本文档对应 `Docker Compose + GROBID` 的服务器版交付方式，默认对外暴露：

- 前端：`3000`
- 后端：`8000`

## 一键部署

仓库已经在服务器上的前提下，直接执行：

```bash
sudo bash scripts/server-deploy.sh
```

脚本会自动完成：

- 安装 Docker Engine 与 Docker Compose Plugin
- 创建缺失的 `.env`、`models.json`、`output/`
- 为 `.env` 补默认 `GROBID_URL=http://grobid:8070`
- 构建并启动 `frontend`、`backend`、`grobid`
- 检查 `http://127.0.0.1:8000/api/health` 与 `http://127.0.0.1:3000`

## 服务结构

`docker-compose.yml` 启动三个服务：

- `frontend`：Next.js，监听 `3000`
- `backend`：FastAPI/Uvicorn，监听 `8000`
- `grobid`：内部容器，供后端 PDF 结构化解析使用

默认情况下，后端通过 `http://grobid:8070` 访问 GROBID。  
如果你想禁用 GROBID，可以把 `.env` 里的 `GROBID_URL` 设为空，或在设置页改成空值后保存。

## 持久化文件

以下内容会保留在宿主机：

- `.env`
- `models.json`
- `output/`

说明：

- `.env` 保存运行时配置
- `models.json` 保存模型档案，可能包含密钥信息，请注意权限控制
- `output/` 保存历史记录、缓存和导出产物

## 常用命令

首次部署或更新代码后重新构建：

```bash
sudo docker compose up -d --build
```

查看服务状态：

```bash
sudo docker compose ps
```

查看日志：

```bash
sudo docker compose logs -f backend
sudo docker compose logs -f frontend
sudo docker compose logs -f grobid
```

停止服务：

```bash
sudo docker compose down
```

## 健康检查

后端健康检查：

```bash
curl http://127.0.0.1:8000/api/health
```

前端首页检查：

```bash
curl -I http://127.0.0.1:3000
```

## 配置建议

- 优先在 `.env` 中填入 `OPENAI_API_KEY`
- 如需 Notion，同步配置 `NOTION_TOKEN` 和 `NOTION_PARENT_PAGE_ID`
- 如需全文抓取增强，可配置 `UNPAYWALL_EMAIL`
- 如需代理，填写 `HTTP_PROXY`
- `GROBID_URL` 在 Compose 服务器版默认使用 `http://grobid:8070`

## 常见问题

前端能打开但请求失败：

- 确认 `8000` 端口已开放
- 确认后端健康检查返回 `status: ok`
- 确认浏览器访问的主机名和后端 `8000` 端口一致

GROBID 相关解析失败：

- 查看 `sudo docker compose logs -f grobid`
- 确认 `backend` 容器环境中的 `GROBID_URL` 不是错误地址
- 如果不需要 GROBID，可将其清空，后端会回退到 `pypdf/PyMuPDF`

更新了设置页配置但重启后没保留：

- 确认 `.env` 与 `models.json` 没有被手动删除
- 确认 Compose 仍按仓库根目录中的 `docker-compose.yml` 启动
