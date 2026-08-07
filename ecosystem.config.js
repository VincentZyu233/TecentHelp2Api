module.exports = {
  apps: [{
    name: 'yuanbao-openai-proxy',
    script: './proxy.js',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 8080,
      // API_KEY: 'sk-your-secret-key',   // 取消注释以启用鉴权
      // DEFAULT_USERID: 'your-userid',
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
