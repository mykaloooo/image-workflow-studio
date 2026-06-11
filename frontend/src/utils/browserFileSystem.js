// 浏览器原生文件系统工具类 - 使用 File System Access API

class BrowserFileSystem {
  constructor() {
    this.lastHandle = null;  // 保存最后使用的文件句柄，用于直接保存
  }

  // 使用浏览器原生保存对话框
  async showSaveDialog(projectName, suggestedName) {
    const options = {
      suggestedName: suggestedName,
      types: [
        {
          description: 'JSON 文件',
          accept: { 'application/json': ['.json'] },
        },
      ],
    };

    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker(options);
        this.lastHandle = handle;
        return handle;
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('保存对话框打开失败:', e);
        }
        return null;
      }
    }

    // 降级方案：创建下载链接
    return 'download';
  }

  // 直接保存到已有句柄（不弹出对话框）
  async saveToHandle(handle, content) {
    try {
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return true;
    } catch (e) {
      console.error('保存到句柄失败:', e);
      return false;
    }
  }

  // 保存项目（直接保存，如果有句柄的话）
  async saveProject(project, forceNewFile = false) {
    const safeName = project.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
    const fileName = `${safeName}_${project.id}.json`;
    const content = JSON.stringify(project, null, 2);

    // 如果有已保存的句柄且不是强制新文件，直接保存
    if (this.lastHandle && !forceNewFile) {
      const success = await this.saveToHandle(this.lastHandle, content);
      if (success) {
        return { success: true, method: 'native', fileName: this.lastHandle.name || fileName, isOverwrite: true };
      }
      // 如果直接保存失败，回退到弹出对话框
    }

    // 弹出保存对话框
    const handle = await this.showSaveDialog(project.name, fileName);

    if (handle === 'download') {
      // 降级：使用下载方式
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      return { success: true, method: 'download' };
    }

    if (!handle) {
      throw new Error('用户取消保存');
    }

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

    return { success: true, method: 'native', fileName: handle.name || fileName, isOverwrite: false };
  }

  // 另存为（强制弹出对话框）
  async saveProjectAs(project) {
    return await this.saveProject(project, true);
  }

  // 清除句柄（新建项目时调用）
  clearHandle() {
    this.lastHandle = null;
  }

  // 检查是否有已保存的文件句柄
  hasHandle() {
    return this.lastHandle !== null;
  }

  // 使用浏览器原生打开对话框
  async showOpenDialog() {
    const options = {
      types: [
        {
          description: 'JSON 文件',
          accept: { 'application/json': ['.json'] },
        },
      ],
      multiple: false,
    };

    if ('showOpenFilePicker' in window) {
      try {
        const handles = await window.showOpenFilePicker(options);
        this.lastHandle = handles[0];
        return handles[0];
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('打开对话框失败:', e);
        }
        return null;
      }
    }

    return null;
  }

  // 加载项目
  async loadProject() {
    const handle = await this.showOpenDialog();
    if (!handle) {
      throw new Error('用户取消选择');
    }

    const file = await handle.getFile();
    const content = await file.text();

    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error('项目文件格式错误');
    }
  }

  // 导出项目（带文件名提示）
  async exportProject(project) {
    return await this.saveProject(project, true);
  }
}

// 导出单例
export const browserFS = new BrowserFileSystem();

// 辅助函数：生成项目ID
export function generateProjectId() {
  return `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// 辅助函数：创建新项目
export function createNewProject(name, nodes = [], edges = []) {
  return {
    id: generateProjectId(),
    name: name || '未命名项目',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: nodes,
    edges: edges,
    thumbnail: null
  };
}

// 检测浏览器是否支持 File System Access API
export function isFileSystemSupported() {
  return 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
}
