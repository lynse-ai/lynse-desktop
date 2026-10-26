FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.mjs ./
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.mjs"]
