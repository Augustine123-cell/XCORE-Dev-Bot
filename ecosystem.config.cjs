// PM2: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: "xcore",
    script: "src/index.js",
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_restarts: 50,
    watch: false,
    max_memory_restart: "500M",
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    time: true,
  }],
};
