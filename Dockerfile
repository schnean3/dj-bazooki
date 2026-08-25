FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8888
EXPOSE 8888
CMD ["node", "server.js"]
