const { CopyRspackPlugin, SwcJsMinimizerRspackPlugin } = require('@rspack/core');
const createConfig = require('./build.config');

module.exports = (env = {}) => {
    const config = createConfig(env, {
        CopyPlugin: CopyRspackPlugin,
        HtmlPlugin: require('html-rspack-plugin'),
        typescriptRule: {
            test: /\.tsx?$/,
            exclude: /node_modules/,
            loader: 'builtin:swc-loader',
            options: {
                jsc: {
                    parser: { syntax: 'typescript' },
                    target: 'es5',
                    // Match TypeScript's callable ES5 constructors and assignment-style fields.
                    loose: true,
                    transform: { useDefineForClassFields: false },
                },
            },
        },
        minimizer: new SwcJsMinimizerRspackPlugin({
            extractComments: /^\**!|@preserve|@license|@cc_on/i,
        }),
    });
    // Retain Webpack's warning severity for existing type reexports and GraphicsEndFill.
    config.module.parser = { javascript: { exportsPresence: 'auto' } };
    return config;
};
