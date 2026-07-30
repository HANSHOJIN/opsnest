export function isExplicitServerTask(input: string) {
  return /(?:查看|检查|列出|列举|显示|获取|统计|查询|安装|卸载|升级|更新|删除|创建|导出|下载|上传|运行|执行|重启|停止|启动|修复|诊断|排查|部署|备份|清理|搜索|监控|连接).*(?:服务器|系统|服务|软件|应用|容器|Docker|Nginx|日志|文件|磁盘|内存|进程|端口|版本|网络|配置|任务|cron|主机)/i.test(input)
    || /(?:为什么|怎么).*(?:打不开|失败|异常|断开|close|error|报错|占满|卡顿|变慢)/i.test(input);
}
