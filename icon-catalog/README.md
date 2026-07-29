# OpsNest 服务图标目录

这里保存从 iStoreOS 软件市场页面提取的图标资源和名称映射。

## 目录约定

- `src/assets/`：内置基础图标，会随 OpsNest EXE 打包。
- `icon-catalog/extended/`：扩展图标，不被 Vite 引用，不会进入 EXE；后续可由 OpsNest 从 GitHub 图标仓库按需下载。
- `manifest.json`：图标文件与软件名称的映射索引。

后续在线图标流程：

```text
本地基础图标
    ↓ 未命中
读取远程 manifest
    ↓ 匹配软件 ID / 别名
下载单个图标到本地缓存
    ↓
服务卡片显示
```

当前仓库处于 private 状态时，不能让普通客户端直接读取 GitHub raw 资源。正式启用在线扩展图标时，应将目录放到公开的图标仓库，或提供公开的静态 CDN 地址；主程序仓库仍可保持 private。

## 来源说明

这些文件来自用户保存的 iStoreOS LuCI 软件市场页面。图标可能属于对应软件或其发行方，正式公开图标仓库前需要逐项确认授权、来源和署名要求。此目录用于开发整理，不代表 OpsNest 对第三方图标拥有版权。
