# 代码架构

## 目标

这次重构解决的不是“文件太长”，而是入口层直接持有数据库、模型调用、业务规则、任务状态和静态路由造成的依赖倒置。新的依赖方向固定为：

```text
server.js
  -> src/bootstrap.js
    -> src/application.js（组合根）
      -> http/routes
        -> domain
          -> agents / providers / repositories
      -> jobs
        -> domain/scene-generation-service
```

下层模块不得反向引用 HTTP request/response；Provider 不读取数据库；Repository 不调用模型；Agent 不负责持久化。

## 目录职责

- `src/bootstrap.js`：唯一启动入口，导出 `startServer`。
- `src/http/router.js`：静态资源、动态页面、API 与资源文件的协议路由。
- `src/http/routes/`：把 HTTP 输入转换为领域服务参数，并把结果转换为响应。
- `src/domain/`：会话、轮次、复盘和场景生成的业务规则与事务边界。
- `src/agents/`：四个角色各自的提示、输入整理、输出校验。
- `src/providers/`：聊天、图片、转写、语音合成四种外部服务 I/O。
- `src/repositories/`：SQLite 实现及按会话、场景任务、回放拆分的窄仓储。
- `src/jobs/`：通用进程内队列和场景生成 worker。
- `public/`：按页面拆分浏览器资源；真正跨页的资源才放进 `shared/`。

## 兼容约束

- 浏览器页面 URL 保持 `/`、`/create`、`/scene/:id`、`/replay/:id`、`/admin.html`。
- API 路径、请求字段、状态码和响应结构保持不变。
- `/styles.css`、`/scene.js` 等旧静态地址保留兼容别名，但新 HTML 使用目录化地址。
- `database.js` 保留为开发脚本兼容入口，新服务端代码直接依赖窄仓储。

## 后续边界

`src/application.js` 仍是迁移期组合根，保留场景图片加工和部分会话 HTTP 动作的编排。继续拆分时应按垂直业务切片迁移到现有 Domain/Route 接口，禁止再创建通用 `utils.js` 或按行数拆文件。
