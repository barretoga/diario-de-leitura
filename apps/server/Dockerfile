# Em produção, fixe a imagem por digest: --build-arg NODE_IMAGE=node@sha256:...
ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
COPY --chown=node:node src ./src
COPY --chown=node:node package.json ./package.json
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production PORT=8080 DATABASE_PATH=/data/reading-log.db
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
