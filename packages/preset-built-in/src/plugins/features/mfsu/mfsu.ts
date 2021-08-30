import { BundlerConfigType } from '@umijs/types';
import { chalk, createDebug, mkdirp } from '@umijs/utils';
import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import mime from 'mime';
import { dirname, join, parse } from 'path';
import { IApi } from 'umi';
import webpack from 'webpack';
import BabelImportRedirectPlugin from './babel-import-redirect-plugin';
import BabelPluginAutoExport from './babel-plugin-auto-export';
import BabelPluginWarnRequire from './babel-plugin-warn-require';
import { DEFAULT_MF_NAME, MF_VA_PREFIX } from './constants';
import DepBuilder from './DepBuilder';
import DepInfo from './DepInfo';
import { getUmiRedirect } from './getUmiRedirect';
import { copy } from './utils';

const debug = createDebug('umi:mfsu');

export type TMode = 'production' | 'development';

export const checkConfig = (api: IApi) => {
  const { mfsu } = api.config;

  // .mfsu directory do not match babel-loader
  if (mfsu && mfsu.development && mfsu.development.output) {
    assert(
      /\.mfsu/.test(mfsu.development.output),
      `[MFSU] mfsu.development.output must match /\.mfsu/.`,
    );
  }
  if (mfsu && mfsu.production && mfsu.production.output) {
    assert(
      /\.mfsu/.test(mfsu.production.output),
      `[MFSU] mfsu.production.output must match /\.mfsu/.`,
    );
  }
};

export const getMfsuPath = (api: IApi, { mode }: { mode: TMode }) => {
  if (mode === 'development') {
    const configPath = api.userConfig.mfsu?.development?.output;
    return configPath
      ? join(api.cwd, configPath)
      : join(api.paths.absTmpPath!, '.cache', '.mfsu');
  } else {
    const configPath = api.userConfig.mfsu?.production?.output;
    return configPath
      ? join(api.cwd, configPath)
      : join(api.cwd, './.mfsu-production');
  }
};

export const normalizeReqPath = (api: IApi, reqPath: string) => {
  let normalPublicPath = api.config.publicPath as string;
  if (/^https?\:\/\//.test(normalPublicPath)) {
    normalPublicPath = new URL(normalPublicPath).pathname;
  } else {
    normalPublicPath = normalPublicPath.replace(/^(?:\.+\/?)+/, '/'); // normalPublicPath should start with '/'
  }
  const isMfAssets =
    reqPath.startsWith(`${normalPublicPath}mf-va_`) ||
    reqPath.startsWith(`${normalPublicPath}mf-dep_`) ||
    reqPath.startsWith(`${normalPublicPath}mf-static/`);
  const fileRelativePath = reqPath
    .replace(new RegExp(`^${normalPublicPath}`), '/')
    .slice(1);
  return {
    isMfAssets,
    normalPublicPath,
    fileRelativePath,
  };
};

// mfsu 功能入口
export default function (api: IApi) {
  //获取webpack 别名
  const webpackAlias = {};
  //获取webpack External 配置
  const webpackExternals: any[] = [];
  let publicPath = '/';
  // 依赖信息
  let depInfo: DepInfo;
  // 依赖编译类
  let depBuilder: DepBuilder;
  //当前模式
  let mode: TMode = 'development';

  // umi 插件注册钩子。不用管
  api.onPluginReady({
    fn() {
      const command = process.argv[2];
      if (['dev', 'build'].includes(command)) {
        console.log(chalk.hex('#faac00')('⏱️  MFSU Enabled'));
      }
    },
    stage: 2,
  });

  // 在命令注册函数执行前触发。可以使用 config 和 paths。
  api.onStart(async ({ name, args }) => {
    // 检查mfsu 配置是否正确 没什么好说的
    checkConfig(api);

    // 根据当前命令改模式。没什么好讲的
    if (name === 'build') {
      mode = 'production';
      // @ts-ignore
    } else if (name === 'mfsu' && args._[1] === 'build' && args.mode) {
      // umi mfsu build --mode
      // @ts-ignore
      mode = args.mode || 'development';
    }
    assert(
      ['development', 'production'].includes(mode),
      `[MFSU] Unsupported mode ${mode}, expect development or production.`,
    );

    debug(`mode: ${mode}`);

    // 根据模式取缓存存放文件
    const tmpDir = getMfsuPath(api, { mode });
    debug(`tmpDir: ${tmpDir}`);

    // 不存在创建
    if (!existsSync(tmpDir)) {
      mkdirp.sync(tmpDir);
    }

    // 获取 依赖信息
    // 操作缓存相关
    depInfo = new DepInfo({
      tmpDir,
      mode,
      api,
      cwd: api.cwd,
      webpackAlias,
    });
    debug('load cache');
    // 加载缓存
    depInfo.loadCache();

    // 获取依赖编译对象
    // 打依赖信息生成依赖文件的地方
    depBuilder = new DepBuilder({
      tmpDir,
      mode,
      api,
    });
  });

  // 修改 umi 配置
  // 如果启用umi 。则将umi chunks 修改为 mfsu内部配置的
  api.modifyConfig({
    fn(memo) {
      return {
        ...memo,

        // Always enable dynamicImport when mfsu is enabled
        dynamicImport: memo.dynamicImport || {},

        // Lock chunks when mfsu is enabled
        // @ts-ignore
        chunks: memo.mfsu?.chunks || ['umi'],
      };
    },
    stage: Infinity,
  });

  // 构建完成 开始编译依赖
  api.onBuildComplete(async ({ err }) => {
    if (err) return;
    debug(`build deps in production`);
    await buildDeps();
  });

  // 开发模式下 编译完成 同步编译依赖
  api.onDevCompileDone(async () => {
    debug(`build deps in development`);
    await buildDeps();
  });

  // 描述 mfsu 配置信息
  api.describe({
    key: 'mfsu',
    config: {
      schema(joi) {
        return joi
          .object({
            development: joi.object({
              output: joi.string(),
            }),
            production: joi.object({
              output: joi.string(),
            }),
            mfName: joi.string(),
            exportAllMembers: joi.object(),
            chunks: joi.array().items(joi.string()),
            ignoreNodeBuiltInModules: joi.boolean(),
          })
          .description('open mfsu feature');
      },
    },
    enableBy() {
      return (
        (api.env === 'development' && api.userConfig.mfsu) ||
        (api.env === 'production' && api.userConfig.mfsu?.production) ||
        process.env.ENABLE_MFSU
      );
    },
  });

  // 修改 @umijs/babel-preset-umi 的配置项。
  api.modifyBabelPresetOpts({
    fn: (opts, args) => {
      return {
        ...opts,
        // 部分插件会开启 @babel/import-plugin，但是会影响 mfsu 模式的使用，在此强制关闭
        ...(args.mfsu
          ? {}
          : {
              // 顶部await 插件
              // 见 babel-plugin-import-to-await-require 包
              importToAwaitRequire: {
                remoteName:
                  (api.config.mfsu && api.config.mfsu.mfName) ||
                  DEFAULT_MF_NAME,
                matchAll: true,
                webpackAlias,
                webpackExternals,
                alias: {
                  [api.cwd]: '$CWD$',
                },
                // @ts-ignore
                exportAllMembers: api.config.mfsu?.exportAllMembers,

                // 转换依赖
                onTransformDeps(opts: {
                  file: string;
                  source: string;
                  isMatch: boolean;
                  isExportAllDeclaration?: boolean;
                }) {
                  const file = opts.file.replace(
                    api.paths.absSrcPath! + '/',
                    '@/',
                  );
                  if (process.env.MFSU_DEBUG && !opts.source.startsWith('.')) {
                    if (process.env.MFSU_DEBUG === 'MATCHED' && !opts.isMatch)
                      return;
                    if (process.env.MFSU_DEBUG === 'UNMATCHED' && opts.isMatch)
                      return;
                    console.log(
                      `> import ${chalk[opts.isMatch ? 'green' : 'red'](
                        opts.source,
                      )} from ${file}, ${
                        opts.isMatch ? 'MATCHED' : 'UNMATCHED'
                      }`,
                    );
                  }
                  // collect dependencies
                  // 收集依赖
                  if (opts.isMatch) {
                    depInfo.addTmpDep(opts.source, file);
                  }
                },
              },
            }),
      };
    },
    stage: Infinity,
  });

  // 修改 babel 配置
  api.modifyBabelOpts({
    fn: async (opts) => {
      webpackAlias['core-js'] = dirname(
        require.resolve('core-js/package.json'),
      );
      webpackAlias['regenerator-runtime/runtime'] = require.resolve(
        'regenerator-runtime/runtime',
      );

      // 看哪些包 需要走 babel-import-redirect-plugin 转一下
      // @ts-ignore
      const umiRedirect = await getUmiRedirect(process.env.UMI_DIR);

      // 降低 babel-preset-umi 的优先级，保证 core-js 可以被插件及时编译
      opts.presets?.forEach((preset) => {
        if (preset instanceof Array && /babel-preset-umi/.test(preset[0])) {
          preset[1].env.useBuiltIns = false;
        }
      });
      opts.plugins = [
        BabelPluginWarnRequire,
        BabelPluginAutoExport,
        [
          BabelImportRedirectPlugin,
          {
            umi: umiRedirect,
            dumi: umiRedirect,
            '@alipay/bigfish': umiRedirect,
          },
        ],
        ...opts.plugins,
      ];
      return opts;
    },
    stage: Infinity,
  });

  //添加在 webpack compiler 中间件之前的中间件，返回值格式为 express 中间件
  api.addBeforeMiddlewares(() => {
    return (req, res, next) => {
      const path = req.path;
      const { isMfAssets, fileRelativePath } = normalizeReqPath(api, req.path);
      if (isMfAssets) {
        // 把预编译的资源吐出来
        depBuilder.onBuildComplete(() => {
          const mfsuPath = getMfsuPath(api, { mode: 'development' });
          const content = readFileSync(
            join(mfsuPath, fileRelativePath),
            'utf-8',
          );
          res.setHeader('content-type', mime.lookup(parse(path || '').ext));
          // 排除入口文件，因为 hash 是入口文件控制的
          if (!/remoteEntry.js/.test(req.url)) {
            res.setHeader('cache-control', 'max-age=31536000,immutable');
          }
          res.send(content);
        });
      } else {
        next();
      }
    };
  });

  // 修改 bundle 配置。
  api.register({
    key: 'modifyBundleConfig',
    fn(memo: any, { type, mfsu }: { mfsu: boolean; type: BundlerConfigType }) {
      if (type === BundlerConfigType.csr) {
        Object.assign(webpackAlias, memo.resolve!.alias || {});
        const externals = memo.externals || {};
        webpackExternals.push(
          ...(Array.isArray(externals) ? externals : [externals]),
        );
        publicPath = memo.output.publicPath;

        if (!mfsu) {
          // 提供给其他应用共享的依赖
          const mfName =
            (api.config.mfsu && api.config.mfsu.mfName) || DEFAULT_MF_NAME;
          memo.plugins.push(
            new webpack.container.ModuleFederationPlugin({
              name: 'umi-app',
              remotes: {
                [mfName]: `${mfName}@${MF_VA_PREFIX}remoteEntry.js`,
              },
            }),
          );

          // 避免 MonacoEditorWebpackPlugin 在项目编译阶段重复编译 worker
          const hasMonacoPlugin = memo.plugins.some((plugin: object) => {
            return plugin.constructor.name === 'MonacoEditorWebpackPlugin';
          });
          if (hasMonacoPlugin) {
            memo.plugins.push(
              new (class MonacoEditorWebpackPluginHack {
                apply(compiler: webpack.Compiler) {
                  const taps: { type: string; fn: Function; name: string }[] =
                    compiler.hooks.make['taps'];
                  compiler.hooks.make['taps'] = taps.filter((tap) => {
                    // ref: https://github.com/microsoft/monaco-editor-webpack-plugin/blob/3e40369/src/plugins/AddWorkerEntryPointPlugin.ts#L34
                    return !(tap.name === 'AddWorkerEntryPointPlugin');
                  });
                }
              })(),
            );
          }
        }
      }
      return memo;
    },
    stage: Infinity,
  });

  // 编译完成 开始编译依赖
  async function buildDeps(opts: { force?: boolean } = {}) {
    const { shouldBuild } = depInfo.loadTmpDeps();
    debug(`shouldBuild: ${shouldBuild}, force: ${opts.force}`);
    if (opts.force || shouldBuild) {
      await depBuilder.build({
        deps: depInfo.data.deps,
        webpackAlias,
        // 编译完成之后写缓存。通知客户端刷新
        onBuildComplete(err: any, stats: any) {
          debug(`build complete with err ${err}`);
          if (err || stats.hasErrors()) {
            return;
          }
          debug('write cache');
          depInfo.writeCache();

          if (mode === 'development') {
            const server = api.getServer();
            debug(`refresh server`);
            server.sockWrite({ type: 'ok', data: { reload: true } });
          }
        },
      });
    }

    // 讲缓存写到输出文件内
    if (mode === 'production') {
      // production 模式，build 完后将产物移动到 dist 中
      debug(`copy mf output files to dist`);
      copy(
        depBuilder.tmpDir,
        join(api.cwd, api.userConfig.outputPath || './dist'),
      );
    }
  }

  // 注册命令
  // npx umi mfsu build
  // npx umi mfsu build --mode production
  // npx umi mfsu build --mode development --force
  api.registerCommand({
    name: 'mfsu',
    async fn({ args }) {
      switch (args._[0]) {
        case 'build':
          console.log('[MFSU] build deps...');
          await buildDeps({
            force: args.force as boolean,
          });
          break;
        default:
          throw new Error(
            `[MFSU] Unsupported subcommand ${args._[0]} for mfsu.`,
          );
      }
    },
  });
}
