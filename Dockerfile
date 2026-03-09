FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

COPY package.json ./
RUN npm install

# Playwright browsers already installed in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
