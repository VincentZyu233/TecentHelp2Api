FROM node:22-alpine
WORKDIR /app
COPY proxy.js index.html admin.html config.json ./
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
CMD ["node", "proxy.js"]
