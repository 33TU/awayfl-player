const createConfig = require('./build.config');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env = {}) => createConfig(env, {
    CopyPlugin: require('copy-webpack-plugin'),
    HtmlPlugin: require('html-webpack-plugin'),
    typescriptRule: {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        loader: require.resolve('ts-loader'),
        options: { experimentalWatchApi: true, transpileOnly: true },
    },
    minimizer: new TerserPlugin({
        extractComments: {
            condition: /^\**!|@preserve|@license|@cc_on/i,
            filename: 'LICENSES.txt',
        },
    }),
});
