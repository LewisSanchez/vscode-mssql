# Fix: Slow Schema Compare Include/Exclude All Differences

**Issue**: [microsoft/vscode-mssql#20019](https://github.com/microsoft/vscode-mssql/issues/20019)
**Branch**: `lewissanchez/bug/slow-include-exclude-all-schema-compare`

## Problem

When users click select/deselect all in Schema Compare results, the UI becomes unresponsive for up to 5 minutes.

## Root Cause

`SchemaCompareIncludeExcludeAllNodesOperation.cs` in SQL Tools Service calls `ComparisonResult.Include(difference)` / `ComparisonResult.Exclude(difference)` **one at a time** for every difference in the comparison result.

The DacFx `SchemaComparisonResult` class ([API docs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.sqlserver.dac.compare.schemacomparisonresult?view=sql-dacfx-162)) has no bulk Include/Exclude API — only single-difference methods:

- `Include(SchemaDifference)` — include one difference
- `Exclude(SchemaDifference)` — exclude one difference

Each individual call performs internal dependency resolution and state mutation, making it **O(N)** DacFx calls where N = number of differences.

Additionally, the current `IncludeExcludeAllDifferences` method (line 84-101 in the file) uses **recursive retry with no termination guard**: if `Exclude()` fails for a difference (due to included dependencies blocking it), that difference is retried in subsequent passes. This retry loop has no max depth, risking infinite recursion. For Exclude All on large comparisons, this results in **O(N × D)** DacFx calls where D = depth of the dependency chain.

### Current problematic code

**File**: `sqltoolsservice/src/Microsoft.SqlTools.ServiceLayer/SchemaCompare/SchemaCompareIncludeExcludeAllNodesOperation.cs`

```csharp
private void IncludeExcludeAllDifferences(List<SchemaDifference> schemaDifferences)
{
    var problematicDifferences = new List<SchemaDifference>();
    foreach (SchemaDifference difference in schemaDifferences)
    {
        // Called N times - each call is expensive
        this.Success = this.Parameters.IncludeRequest
            ? this.ComparisonResult.Include(difference)
            : this.ComparisonResult.Exclude(difference);

        if (!this.Success)
        {
            problematicDifferences.Add(difference);
        }
    }

    // Recursive retry with NO termination guard - potential infinite loop
    if (problematicDifferences.Count != 0)
    {
        IncludeExcludeAllDifferences(problematicDifferences);
    }
}
```

### Why Exclude All is especially slow

- `Exclude()` returns `false` if the difference has included dependencies (as documented in `SchemaCompareIncludeExcludeNodeOperation.cs`: "Exclude will return false if included dependencies are found")
- The recursive retry is trying to resolve dependency ordering through brute force — retrying failed excludes until their blocking dependencies have been excluded in a prior pass
- With a dependency chain of depth D, this means D full passes through all remaining differences

### Why Include All is less affected

- `Include()` automatically includes dependencies needed by the difference being included
- So most includes succeed on the first pass, and the recursive retry rarely fires

## Call chain

```
vscode-mssql extension (schemaCompareWebViewController.ts, line 1749)
  → registerReducer("includeExcludeAllNodes")
    → includeExcludeAllNodes() (schemaCompareUtils.ts, line 342)
      → schemaCompareService.includeExcludeAllNodes()
        → [JSON-RPC to SQL Tools Service]
          → SchemaCompareService.HandleSchemaCompareIncludeExcludeAllNodesRequest() (SchemaCompareService.cs, line 311)
            → SchemaCompareIncludeExcludeAllNodesOperation.Execute() (line 57)
              → IncludeExcludeAllDifferences() ← THE BOTTLENECK (line 84)
                → ComparisonResult.Include(difference) / .Exclude(difference)  ← one at a time, N times
```

## Fix Plan

### Step 1: Add bulk IncludeAll/ExcludeAll methods to DacFx

Add two new methods to the `SchemaComparisonResult` class in DacFx:

```csharp
/// <summary>
/// Include all differences in the comparison result at once.
/// More efficient than calling Include() for each difference individually.
/// </summary>
public void IncludeAll();

/// <summary>
/// Exclude all differences in the comparison result at once.
/// More efficient than calling Exclude() for each difference individually.
/// </summary>
public void ExcludeAll();
```

**Implementation guidance**: These methods should set the inclusion state of all differences in a single batch, performing dependency resolution once rather than per-difference. The internal implementation should toggle the included flag for all `SchemaDifference` objects at once, bypassing the per-call dependency validation since the target state (all included or all excluded) is inherently consistent from a dependency perspective — there are no dependency conflicts when everything has the same state.

### Step 2: Update SQL Tools Service to use the new DacFx bulk API

**File**: `sqltoolsservice/src/Microsoft.SqlTools.ServiceLayer/SchemaCompare/SchemaCompareIncludeExcludeAllNodesOperation.cs`

Replace the current loop + retry approach in `Execute()` with direct calls to the new bulk API:

```csharp
public void Execute(TaskExecutionMode mode)
{
    this.CancellationToken.ThrowIfCancellationRequested();

    try
    {
        if (this.Parameters.IncludeRequest)
        {
            this.ComparisonResult.IncludeAll();
        }
        else
        {
            this.ComparisonResult.ExcludeAll();
        }

        this.Success = true;
    }
    catch (Exception e)
    {
        ErrorMessage = e.Message;
        Logger.Error($"Schema compare include/exclude all operation {this.OperationId} failed: {e.Message}");
        throw;
    }

    // Build the result diff entries
    this.AllIncludedOrExcludedDifferences = new List<DiffEntry>();
    if (this.ComparisonResult.Differences != null)
    {
        foreach (SchemaDifference difference in this.ComparisonResult.Differences)
        {
            DiffEntry diffEntry = SchemaCompareUtils.CreateDiffEntry(difference, null, this.ComparisonResult);
            this.AllIncludedOrExcludedDifferences.Add(diffEntry);
        }
    }
}
```

Delete the `IncludeExcludeAllDifferences` private method entirely.

### Step 3 (Interim): Safety improvements if DacFx bulk API isn't ready yet

If the DacFx bulk API is not yet available and we need an interim fix, add a max retry limit and progress check to the existing method:

```csharp
private void IncludeExcludeAllDifferences(List<SchemaDifference> schemaDifferences, int retryCount = 0)
{
    const int MaxRetries = 100;
    var problematicDifferences = new List<SchemaDifference>();

    foreach (SchemaDifference difference in schemaDifferences)
    {
        this.CancellationToken.ThrowIfCancellationRequested();
        this.Success = this.Parameters.IncludeRequest
            ? this.ComparisonResult.Include(difference)
            : this.ComparisonResult.Exclude(difference);

        if (!this.Success)
        {
            problematicDifferences.Add(difference);
        }
    }

    if (problematicDifferences.Count != 0
        && retryCount < MaxRetries
        && problematicDifferences.Count < schemaDifferences.Count)  // Ensure progress is being made
    {
        IncludeExcludeAllDifferences(problematicDifferences, retryCount + 1);
    }
    else if (problematicDifferences.Count != 0)
    {
        Logger.Warning($"Could not {(this.Parameters.IncludeRequest ? "include" : "exclude")} " +
            $"{problematicDifferences.Count} differences after {retryCount} retries");
        this.Success = false;
    }
}
```

Key improvements over current code:

- **Max retry limit** (100) prevents infinite recursion
- **Progress check** (`problematicDifferences.Count < schemaDifferences.Count`) — only retry if at least one difference succeeded in the current pass; bail out if stuck
- **Cancellation token check** in the inner loop allows the user to cancel the operation

## Files to modify

| File                                                                                                                       | Change                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **DacFx**: `SchemaComparisonResult` class                                                                                  | Add `IncludeAll()` and `ExcludeAll()` methods                   |
| **SQL Tools Service**: `src/Microsoft.SqlTools.ServiceLayer/SchemaCompare/SchemaCompareIncludeExcludeAllNodesOperation.cs` | Call new bulk API; remove `IncludeExcludeAllDifferences` method |

## Existing tests to update

- `sqltoolsservice/test/Microsoft.SqlTools.ServiceLayer.IntegrationTests/SchemaCompare/SchemaCompareServiceTests.cs`
    - `IncludeExcludeAllWithDacpacToDacpacComparison` (line 1724)
    - `IncludeExcludeAllWithDatabaseToDatabaseComparison` (line 1797)

These tests should continue to pass with the new implementation since the observable behavior (all differences included/excluded) is unchanged.

## Verification

1. **Existing integration tests**: The two tests above should pass unchanged
2. **Manual test**: Open Schema Compare in VS Code, compare two databases with many differences (100+), click "Exclude All" / "Include All" — should complete in seconds rather than minutes
3. **Regression**: After Include All / Exclude All, verify individual include/exclude of single nodes still works
4. **Edge cases**: Empty comparison result, comparison with single difference, comparison where all are already in the target state
