// IndexedDB 工具类 - 用于保存和加载项目

const DB_NAME = 'ImageWorkflowStudio';
const DB_VERSION = 1;
const STORE_NAME = 'projects';

class ProjectDB {
  constructor() {
    this.db = null;
  }

  // 初始化数据库
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 创建项目存储
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          objectStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          objectStore.createIndex('name', 'name', { unique: false });
        }
      };
    });
  }

  // 保存项目
  async saveProject(project) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const objectStore = transaction.objectStore(STORE_NAME);

      const request = objectStore.put(project);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 获取所有项目
  async getAllProjects() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const objectStore = transaction.objectStore(STORE_NAME);
      const index = objectStore.index('updatedAt');

      const request = index.openCursor(null, 'prev'); // 按更新时间倒序
      const projects = [];

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          projects.push(cursor.value);
          cursor.continue();
        } else {
          resolve(projects);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  // 获取单个项目
  async getProject(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const objectStore = transaction.objectStore(STORE_NAME);
      const request = objectStore.get(id);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // 删除项目
  async deleteProject(id) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const objectStore = transaction.objectStore(STORE_NAME);
      const request = objectStore.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // 更新项目
  async updateProject(id, updates) {
    const project = await this.getProject(id);
    if (!project) throw new Error('项目不存在');

    const updatedProject = {
      ...project,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    return this.saveProject(updatedProject);
  }
}

// 导出单例
export const projectDB = new ProjectDB();

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
