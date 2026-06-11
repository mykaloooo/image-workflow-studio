// 本地文件系统工具类 - 用于保存和加载项目到用户选择的目录

class LocalFileSystem {
  constructor() {
    this.projectDir = null;
  }

  // 设置项目保存目录
  async setProjectDirectory() {
    if (!window.electronAPI) {
      throw new Error('Electron API 不可用，请在桌面应用中运行');
    }

    const dirPath = await window.electronAPI.selectDirectory();
    if (dirPath) {
      this.projectDir = dirPath;
      return dirPath;
    }
    return null;
  }

  // 获取当前项目目录
  getProjectDirectory() {
    return this.projectDir;
  }

  // 检查是否设置了项目目录
  isConfigured() {
    return this.projectDir !== null;
  }

  // 保存项目到本地文件
  async saveProject(project) {
    if (!this.projectDir) {
      throw new Error('请先设置项目保存目录');
    }

    if (!window.electronAPI) {
      throw new Error('Electron API 不可用');
    }

    // 为项目生成文件名
    const safeName = project.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_');
    const fileName = `${safeName}_${project.id}.json`;
    const filePath = path.join(this.projectDir, fileName);
    
    const content = JSON.stringify(project, null, 2);
    const result = await window.electronAPI.saveFile(filePath, content);
    
    if (!result.success) {
      throw new Error(`保存失败: ${result.error}`);
    }
    
    return filePath;
  }

  // 从本地文件加载项目
  async loadProject(filePath) {
    if (!window.electronAPI) {
      throw new Error('Electron API 不可用');
    }

    const result = await window.electronAPI.readFile(filePath);
    
    if (!result.success) {
      throw new Error(`读取失败: ${result.error}`);
    }
    
    return JSON.parse(result.content);
  }

  // 列出保存的项目
  async listProjects() {
    if (!this.projectDir) {
      return [];
    }

    if (!window.electronAPI) {
      throw new Error('Electron API 不可用');
    }

    const result = await window.electronAPI.readDir(this.projectDir);
    
    if (!result.success) {
      throw new Error(`读取目录失败: ${result.error}`);
    }

    const projects = [];
    for (const file of result.files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(this.projectDir, file);
        const readResult = await window.electronAPI.readFile(filePath);
        if (readResult.success) {
          try {
            const project = JSON.parse(readResult.content);
            if (project.id && project.name) {
              projects.push({
                ...project,
                filePath: filePath,
                fileName: file
              });
            }
          } catch (e) {
            console.warn(`跳过损坏的项目文件: ${file}`);
          }
        }
      }
    }

    return projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // 删除本地项目
  async deleteProject(filePath) {
    if (!window.electronAPI) {
      throw new Error('Electron API 不可用');
    }

    const fs = require('fs');
    return new Promise((resolve, reject) => {
      fs.unlink(filePath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// 导出单例
export const localFS = new LocalFileSystem();

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

// 辅助函数：检测是否在 Electron 环境中
export function isElectron() {
  return window.electronAPI !== undefined;
}
