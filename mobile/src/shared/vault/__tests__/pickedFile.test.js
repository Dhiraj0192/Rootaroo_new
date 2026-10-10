const { takePickedBytes } = require('../pickedFile');

const MAX = 100;
function io(bytes = new Uint8Array(10), size = 0) {
  return {
    fileSize: jest.fn(() => size),
    readBytes: jest.fn(async () => bytes),
    deleteTemp: jest.fn(async () => {}),
  };
}

describe('takePickedBytes', () => {
  it('reads the bytes, deletes the plain copy, and uses the real byte count', async () => {
    const deps = io(new Uint8Array(42));
    const out = await takePickedBytes({ uri: 'file:///cache/a.pdf', name: 'a.pdf', size: 40 }, MAX, deps);
    expect(out.bytes).toHaveLength(42);
    expect(out.size).toBe(42);
    expect(deps.deleteTemp).toHaveBeenCalledWith('file:///cache/a.pdf');
  });

  it('never loads a file the picker says is too big', async () => {
    const deps = io();
    const out = await takePickedBytes({ uri: 'u', size: MAX + 1 }, MAX, deps);
    expect(out.size).toBe(MAX + 1);
    expect(out.bytes).toBeUndefined();
    expect(deps.readBytes).not.toHaveBeenCalled();
  });

  it('asks the file for its size when the picker gave none, and skips a huge one', async () => {
    const deps = io(new Uint8Array(1), MAX * 10);
    const out = await takePickedBytes({ uri: 'u' }, MAX, deps);
    expect(deps.fileSize).toHaveBeenCalledWith('u');
    expect(out.size).toBe(MAX * 10);
    expect(deps.readBytes).not.toHaveBeenCalled();
  });
});
