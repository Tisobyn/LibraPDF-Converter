FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress fonts-liberation fonts-dejavu-core \
      fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
USER node
ENV PORT=3000 HOME=/tmp
EXPOSE 3000
CMD ["node", "src/server.js"]
