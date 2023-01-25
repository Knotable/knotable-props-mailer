import AwsFileService from "./aws-file";
import FileService from "./file";

export default class FilesService {
  constructor(fileService) {
    this.fileService = fileService;
  }

  async createFromS3Urls(urls) {
    const uniqUrls = new Set(urls);
    const result = await Promise.allSettled(
      Array.from(uniqUrls).map((url) => this.fileService.createByS3Url(url))
    );
    return result
      .filter((res) => res.value !== undefined)
      .map(({ value }) => value);
  }

  static createDefault() {
    const fileService = new FileService(
      Files,
      check,
      AwsFileService.createBySettings()
    );

    return new FilesService(fileService);
  }
}
