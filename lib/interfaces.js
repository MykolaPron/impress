'use strict';

const path = require('node:path');
const fsp = require('node:fs').promises;
const metavm = require('metavm');
const metautil = require('metautil');
const { metarhia, npm } = require('./dependencies.js');
const { Procedure } = require('./procedure.js');
const { Cache } = require('./cache.js');

const getSignature = (method) => {
  const src = method.toString();
  const signature = metautil.between(src, '({', '})');
  if (signature === '') return [];
  return signature.split(',').map((s) => s.trim());
};

class Interfaces extends Cache {
  constructor(place, application) {
    super(place, application);
    this.collection = {};
    this.signatures = {};
  }

  async createScript(fileName) {
    try {
      const code = await fsp.readFile(fileName, 'utf8');
      if (!code) return null;
      const src = 'context => ' + code;
      const options = { context: this.application.sandbox };
      const { exports } = new metavm.MetaScript(fileName, src, options);
      return exports;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.application.console.error(error.stack);
      }
      return null;
    }
  }

  cacheSignature(interfaceName, methodName, method) {
    const name = path.basename(interfaceName, '.js');
    let interfaceMethods = this.signatures[name];
    if (!interfaceMethods) {
      this.signatures[name] = interfaceMethods = {};
    }
    interfaceMethods[methodName] = getSignature(method);
  }

  delete(filePath) {
    const relPath = filePath.substring(this.path.length + 1);
    if (!relPath.includes(path.sep)) return;
    const [interfaceName, methodFile] = relPath.split(path.sep);
    if (!methodFile.endsWith('.js')) return;
    const name = path.basename(methodFile, '.js');
    const [iname, ver] = interfaceName.split('.');
    const version = parseInt(ver, 10);
    const iface = this.collection[iname];
    if (!iface) return;
    const methods = iface[version.toString()];
    if (methods) delete methods[name];
    const internalInterface = this.application.sandbox.api[iname];
    if (internalInterface) delete internalInterface[name];
    const cache = this.signatures[interfaceName];
    if (cache) delete cache[name];
  }

  async change(filePath) {
    if (!filePath.endsWith('.js')) return;
    const script = await this.createScript(filePath);
    if (!script) return;
    const proc = new Procedure(script, 'method', this.application);
    const iface = proc.exports;
    const relPath = filePath.substring(this.path.length + 1);
    const [interfaceName, methodFile] = relPath.split(path.sep);
    if (methodFile) {
      const name = path.basename(methodFile, '.js');
      this.changeInterface(interfaceName, name, proc);
      return;
    }
    if (iface.plugin) {
      this.loadPlugin(interfaceName, iface);
      return;
    }
    for (const name of Object.keys(iface)) {
      const proc = new Procedure(script, name, this.application);
      this.changeInterface(interfaceName, name, proc);
    }
  }

  loadPlugin(interfaceName, iface) {
    const [library, name] = iface.plugin.split('/');
    const lib = metarhia[library] || npm[library];
    if (!lib || !lib.plugins) return;
    const pluginSrc = lib.plugins[name];
    if (!pluginSrc) return;
    const context = this.application.sandbox;
    const { exports } = metavm.createScript(name, pluginSrc, { context });
    const plugin = exports(iface);
    for (const [name, script] of Object.entries(plugin)) {
      const proc = new Procedure(script, name, this.application);
      this.changeInterface(interfaceName, name, proc);
    }
  }

  changeInterface(interfaceName, name, proc) {
    const { internalInterface, methods } = this.prepareInterface(interfaceName);
    methods[name] = proc;
    const { method, exports } = proc;
    internalInterface[name] = method || exports;
    if (method) this.cacheSignature(interfaceName, name, method);
  }

  prepareInterface(interfaceName) {
    const [iname, ver] = interfaceName.split('.');
    const version = parseInt(ver, 10);
    let iface = this.collection[iname];
    const { api } = this.application.sandbox;
    let internalInterface = api[iname];
    if (!iface) {
      this.collection[iname] = iface = { default: version };
      api[iname] = internalInterface = {};
    }
    if (version > iface.default) iface.default = version;
    let methods = iface[ver];
    if (!methods) iface[ver] = methods = {};
    return { internalInterface, methods };
  }
}

module.exports = { Interfaces };
