# PID Ready — production image (ECS / Fly / Render). Build from the repo root:
#   docker build -t pid-ready .
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/rules/package.json packages/rules/
COPY apps/shopify/package.json apps/shopify/
COPY apps/checker/package.json apps/checker/
RUN npm ci
COPY . .
RUN npm run build -w @pidready/rules \
 && npm run build -w @pidready/checker \
 && mkdir -p apps/shopify/public/checker && cp apps/checker/dist/index.html apps/shopify/public/checker/index.html \
 && cd apps/shopify && npx prisma generate && npx react-router build

FROM node:22-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/shopify
EXPOSE 3000
# Runs pending migrations (uses DIRECT_URL on Neon), then serves the app.
CMD ["sh", "-c", "npx prisma migrate deploy && npx react-router-serve ./build/server/index.js"]
