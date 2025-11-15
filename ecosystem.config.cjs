module.exports = {
  apps: [
    {
      name: 'sak-soti-backend',
      script: './index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: true,
      watch_delay: 1000,
      ignore_watch: ['node_modules', 'logs', 'uploads', '.git'],
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'development',
        PORT: 3001
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000
    }
  ]
};

