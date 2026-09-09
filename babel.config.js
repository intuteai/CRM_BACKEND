// Only exists so Jest can transpile the handful of ESM-only packages pulled
// in transitively by sanitize-html (htmlparser2 and its dom* dependencies) —
// the app itself is plain CommonJS and runs fine under plain Node without
// this. See the jest.transformIgnorePatterns override in package.json.
module.exports = {
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
