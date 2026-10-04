'use strict'

const { styleText } = require('node:util')

function paint (style, text) {
  return styleText(style, String(text), { validateStream: false })
}

const tag = {
  chat: paint('gray', '[chat]'),
  nav: paint('cyan', '[nav]'),
  grim: paint(['magenta', 'bold'], '[grim]'),
  ok: paint('green', '[ok]'),
  warn: paint('yellow', '[warn]'),
  err: paint('red', '[err]'),
  info: paint('cyan', '[info]')
}

function line (kind, text) {
  const label = tag[kind] || paint('white', '[' + kind + ']')
  return label + ' ' + text
}

module.exports = { paint, line, tag }
