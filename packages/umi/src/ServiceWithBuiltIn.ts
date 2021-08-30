import { IServiceOpts, Service as CoreService } from '@umijs/core';
import { dirname } from 'path';

class Service extends CoreService {
  constructor(opts: IServiceOpts) {
    // 初始化 umi 路径和版本
    process.env.UMI_VERSION = require('../package').version;
    process.env.UMI_DIR = dirname(require.resolve('../package'));

    super({
      // 配置文件等信息
      ...opts,
      // 注册预设插件
      presets: [
        require.resolve('@umijs/preset-built-in'),
        ...(opts.presets || []),
      ],
      // 注册额外的插件
      plugins: [require.resolve('./plugins/umiAlias'), ...(opts.plugins || [])],
    });
  }
}

export { Service };
