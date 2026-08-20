# trackstat backend — Docker image
# Build (from the trackstat/ directory, so the frontend is included):
#   docker build -f backend/Dockerfile -t trackstat-backend .
# Run:
#   docker run -d --name trackstat -p 3030:3030 trackstat-backend
# Listens on 0.0.0.0:3030 inside the container; point nginx at it.

FROM node:22-alpine

# backend code
WORKDIR /app/server
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/app.js ./

# frontend (served by app.js from ../frontend/index.html)
COPY frontend/ /app/frontend/

ENV PORT=3030
EXPOSE 3030

CMD ["node", "app.js"]
