FROM node:24-alpine

WORKDIR /app
COPY src ./src
COPY package.json ./package.json
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/reading-log.db
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
