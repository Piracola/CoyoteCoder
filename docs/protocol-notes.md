# Protocol Notes

This project treats DG-LAB's official open-source repository as an external reference:

```text
DG-LAB-OPENSOURCE/
```

That directory remains ignored by this repository so it can be updated independently from the official source.

The first project phase does not send real hardware commands. It only produces normalized events and dry-run shock plans. Future DG-LAB Socket V2 integration should continue to route all commands through the safety layer before reaching a controller.
