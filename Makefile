# 废土馆藏 · 本地阅读终端
# 用法：make up / make down / make status / make logs
SHELL := /bin/bash

PORT      ?= 5178
RUN_DIR   := .run
PID_FILE  := $(RUN_DIR)/app.pid
LOG_FILE  := $(RUN_DIR)/app.log
URL       := http://127.0.0.1:$(PORT)
NPX       := npx
RUNTIME_DIR := $(CURDIR)/.runtime
NODE_BIN_DIR := $(RUNTIME_DIR)/node/bin
export PATH := $(NODE_BIN_DIR):$(PATH)

.DEFAULT_GOAL := help
.PHONY: help bootstrap install build package app up down restart status logs dev clean

help: ## 显示可用命令
	@echo "废土馆藏 · WASTELAND ARCHIVE"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  站点：$(URL)   端口可用 PORT=5179 make up 覆盖"

bootstrap: ## 检测并安装 Node / npm 依赖 / ffmpeg / 浏览器
	@sh scripts/bootstrap.sh

install: bootstrap ## 安装依赖（别名）

build: bootstrap ## 打包前端到 dist/（不是独立应用，需本地服务）
	$(NPX) vite build

package: build ## 打可移植包到 release/（含 server + dist + 源码）
	@rm -rf release/wasteland-browser release/wasteland-archive release/wasteland-archive.tar.gz
	@mkdir -p release/wasteland-archive/data
	@cp -R server dist src scripts docs langs bg_screens index.html vite.config.js package.json package-lock.json README.md Makefile release/wasteland-archive/
	@cd release && tar -czf wasteland-archive.tar.gz wasteland-archive
	@echo "● 已生成 release/wasteland-archive.tar.gz"
	@echo "  目标电脑解压后直接：make up"

app: bootstrap ## 构建 macOS 原生 .app（arm64）+ zip
	npm run desktop:zip
	@echo "● 原生 App：release/native/mac-arm64/废土馆藏.app"
	@echo "● 压缩包：release/native/Wasteland-Archive-mac-arm64.zip"
	@echo "● DMG：release/native/Wasteland-Archive-mac-arm64.dmg"

up: bootstrap ## 后台启动（自动检测环境并安装缺失依赖）
	@mkdir -p $(RUN_DIR); \
	if [ -f $(PID_FILE) ] && kill -0 "$$(cat $(PID_FILE))" 2>/dev/null; then \
		echo "● 已在运行 · pid $$(cat $(PID_FILE)) · $(URL)"; exit 0; \
	fi; \
	if lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "✕ 端口 $(PORT) 被占用 · pid $$(lsof -ti tcp:$(PORT) -sTCP:LISTEN | tr '\n' ' ')"; \
		echo "  先执行 make down，或用 PORT=5179 make up"; exit 1; \
	fi; \
	if [ ! -f dist/index.html ]; then echo "→ 首次启动，先打包前端…"; $(MAKE) --no-print-directory build || exit 1; fi; \
	NODE_ENV=production nohup node server/index.js >> $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE); \
	for i in $$(seq 1 80); do curl -fsS $(URL)/api/session >/dev/null 2>&1 && break; sleep 0.25; done; \
	if curl -fsS $(URL)/api/session >/dev/null 2>&1; then \
		echo "● 已启动 · pid $$(cat $(PID_FILE)) · $(URL)"; \
	else \
		echo "✕ 启动失败，最近日志："; tail -n 20 $(LOG_FILE); rm -f $(PID_FILE); exit 1; \
	fi

down: ## 停止后台服务
	@pid=""; \
	if [ -f $(PID_FILE) ]; then pid=$$(cat $(PID_FILE)); fi; \
	if [ -z "$$pid" ] || ! kill -0 "$$pid" 2>/dev/null; then pid=$$(lsof -ti tcp:$(PORT) -sTCP:LISTEN 2>/dev/null); fi; \
	if [ -z "$$pid" ]; then rm -f $(PID_FILE); echo "○ 已经停止"; exit 0; fi; \
	kill $$pid 2>/dev/null || true; \
	for i in $$(seq 1 24); do kill -0 $$pid 2>/dev/null || break; sleep 0.25; done; \
	if kill -0 $$pid 2>/dev/null; then kill -9 $$pid 2>/dev/null || true; fi; \
	rm -f $(PID_FILE); \
	echo "● 已停止 · pid $$pid"

restart: ## 重启（down + up）
	@$(MAKE) --no-print-directory down
	@$(MAKE) --no-print-directory up

status: ## 查看运行状态与账号信息
	@if lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "● 运行中 · pid $$(lsof -ti tcp:$(PORT) -sTCP:LISTEN | tr '\n' ' ' | sed 's/ $$//') · $(URL)"; \
		curl -fsS $(URL)/api/session | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("   登录:",j.authenticated?"OK":"NO","· 账号:",j.account||"-","· token 有效期:",j.expiresAt?new Date(j.expiresAt).toLocaleString("zh-CN"):"-")})'; \
	else echo "○ 未运行 · 执行 make up 启动"; fi

logs: ## 跟踪后台日志（Ctrl-C 退出）
	@mkdir -p $(RUN_DIR); touch $(LOG_FILE)
	@tail -n 60 -f $(LOG_FILE)

dev: bootstrap ## 前台开发模式（Express + Vite 热更新）
	node scripts/dev.mjs

clean: ## 清理构建产物、运行记录与打包目录（不动已归档杂志）
	rm -rf dist $(RUN_DIR) release
