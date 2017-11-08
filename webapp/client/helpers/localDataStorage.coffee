class @LocalDataStore
  constructor: (mountPoint) ->
    @store = new Mongo.Collection(null)
    @isMounted = false
    @_mount(mountPoint) if mountPoint
    return _.extend @store, _.pick @, 'mount', 'unmount'



  mount: (mountPoint) =>
    check mountPoint, String
    @_mount(mountPoint)



  unmount: =>
    @_unmount() if @isMounted



  _mount: (mountPoint) ->
    @_unmount() if @isMounted
    @_initFromLocalCache(mountPoint, @store)
    observer = @_observeChanges(mountPoint, @store)
    @store.destroy = -> observer.stop()
    @isMounted = true



  _unmount: ->
    @store.destroy?()
    @store.remove({})
    @isMounted = false



  _initFromLocalCache: (mountPoint, store) ->
    cachedCollection = @_getCachedDataAt(mountPoint)
    if cachedCollection
      _.each cachedCollection, (item, id) -> store.insert(_.extend item, _id: id)



  _observeChanges: (mountPoint, store) ->
    initializing = true
    observer = store.find().observe
      added:   (document) => not initializing and @_updateCachedDataAt(mountPoint, document._id, document)
      changed: (document) => not initializing and @_updateCachedDataAt(mountPoint, document._id, document)
      removed: (document) => not initializing and @_updateCachedDataAt(mountPoint, document._id)
    initializing = false
    return observer



  _getCachedDataAt: (mountPoint) ->
    keys = mountPoint.split('.')
    cache = amplify.store keys.shift()
    cache = cache[key] while (key = keys.shift()) and cache
    return cache



  _updateCachedDataAt: (mountPoint, documentId, document) ->
    keys = mountPoint.split('.')
    rootKey = keys.shift()
    root = amplify.store(rootKey) or {}
    cache = root
    while (key = keys.shift()) and cache
      cache = (cache[key] = cache[key] or {})
    if document
      cache[documentId] = _.omit document, '_id'
    else if cache[documentId]
      delete cache[documentId]
    amplify.store(rootKey, root)
