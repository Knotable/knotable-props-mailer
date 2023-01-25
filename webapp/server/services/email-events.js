export default class EmailEventsService {
  constructor(store, validator) {
    this.store = store;
    this.validator = validator;
  }

  async getFiles(query = {}, skip, limit) {
    this.validator(query, {
      user_id: Match.Optional(String),
      _id: Match.Optional(String),
    });
    const files = await this.store
      .aggregate([
        { $match: { ...query, file_ids: { $exists: true } } },
        { $sort: { createdDate: 1 } },
        { $project: { file_ids: 1 } },
        { $unwind: "$file_ids" },
        { $group: { _id: null, ids: { $addToSet: "$file_ids" } } },
        {
          $lookup: {
            from: "files",
            let: { fileIds: "$ids" },
            pipeline: [{ $match: { $expr: { $in: ["$_id", "$$fileIds"] } } }],
            as: "files",
          },
        },
        { $unwind: "$files" },
        { $replaceRoot: { newRoot: "$files" } },
        { $skip: skip || 0 },
        { $limit: limit ?? 100 },
      ])
      .toArray();
    return files;
  }

  static createDefault() {
    return new EmailEventsService(EmailEvents.rawCollection(), check);
  }
}
