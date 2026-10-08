# Container image for directory checks (Glama and similar) and for anyone who
# prefers running the server in Docker. Unpaired, it still answers initialize
# and tools/list; pass FORMWARD_API_KEY for real tool calls.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
ENTRYPOINT ["node", "dist/cli.js"]
