module.exports = {
  apps: [{
    name: 'discord-music-bot',
    script: 'index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '512M',
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
