FROM node:22-alpine

ARG NEXT_SERVER_API_URL=http://backend:8000

ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_SERVER_API_URL=${NEXT_SERVER_API_URL}

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --include=dev

COPY frontend/ ./
RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]
