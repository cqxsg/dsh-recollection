window.__ModuleLoader__.load({ id: 'dsh-recollection-test-probe', factory: () => ({
  inject: ['remote', 'remote.recall', 'sessions', 'layout', 'uiWorkspace', 'recallClient', 'connection', 'modules'],
  apply(ctx) {
    window.__recallProbe = ctx;
    return () => { delete window.__recallProbe; };
  },
}) });
