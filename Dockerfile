FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
RUN npm install && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY skills ./skills
EXPOSE 8080
ENV MCP_TRANSPORT=http
CMD ["node", "dist/index.js", "http"]
