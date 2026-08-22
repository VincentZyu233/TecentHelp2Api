FROM node:22-alpine
WORKDIR /app
COPY proxy.js index.html admin.html config.json ./
# 端口通过环境变量覆盖，默认 8080；如需改用 config.json 中的端口，删除 ENV PORT 即可
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "proxy.js"]
