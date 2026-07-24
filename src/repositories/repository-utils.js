function bindMethods(target, names) {
  return Object.fromEntries(names.map((name) => {
    if (typeof target[name] !== "function") throw new Error(`仓储方法不存在：${name}`);
    return [name, target[name].bind(target)];
  }));
}

module.exports = { bindMethods };
