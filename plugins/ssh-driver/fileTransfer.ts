/**
 * FileTransfer — SSH 文件传输 (SCP/SFTP)
 *
 * Requirements: A8.36
 */

export class FileTransfer {
  /**
   * 上传文件到远程设备
   */
  async upload(client: any, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err: Error | null, sftp: any) => {
        if (err) return reject(err);

        sftp.fastPut(localPath, remotePath, (err2: Error | null) => {
          sftp.end();
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }

  /**
   * 从远程设备下载文件
   */
  async download(client: any, remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err: Error | null, sftp: any) => {
        if (err) return reject(err);

        sftp.fastGet(remotePath, localPath, (err2: Error | null) => {
          sftp.end();
          if (err2) return reject(err2);
          resolve();
        });
      });
    });
  }
}
