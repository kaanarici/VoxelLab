# Accuracy Ledger

Reference: nibabel 5.4.2, pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1
Tolerance: 0.000001

This regenerable trust artifact checks synthetic NIfTI-1 fixtures against nibabel goldens and synthetic DICOM stacks against pydicom-read DICOM PS3.3 Image Plane goldens. VoxelLab stores patient-space geometry as LPS millimeters, so nibabel RAS+ affines are transformed to LPS+ millimeters before comparison.

Checked VoxelLab paths:
- nifti-affine-vs-nibabel: js/dicom/nifti-import-parse.js parseNIfTI -> js/core/geometry.js geometryFromSeries
- dicom-patient-space-vs-pydicom-ps3.3: scripts/check_accuracy_ledger.mjs dcmjs fixture adapter -> js/dicom/dicom-frame-meta.js frameMetasForInstance -> js/dicom/dicom-import-parse.js buildDICOMSeriesResult -> js/core/geometry.js geometryFromSeries

| Oracle | Fixture | Reference | Tolerance | Max abs error | Result |
|---|---|---:|---:|---:|---|
| nifti-affine-vs-nibabel | anisotropic-sform-mm.nii | nibabel 5.4.2 | 0.000001 | 0 | PASS |
| nifti-affine-vs-nibabel | identity-qform-mm.nii | nibabel 5.4.2 | 0.000001 | 0 | PASS |
| nifti-affine-vs-nibabel | micron-sform-non-mm.nii | nibabel 5.4.2 | 0.000001 | 0 | PASS |
| nifti-affine-vs-nibabel | oblique-qform-mm.nii | nibabel 5.4.2 | 0.000001 | 8.882e-16 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | axial-regular | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 0 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | duplicate-ipp | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 0 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | enhanced-multiframe | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 9.934e-9 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | mixed-frame-of-reference | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 0 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | oblique-iop | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 1.776e-15 | PASS |
| dicom-patient-space-vs-pydicom-ps3.3 | reversed-slice-order | pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1 | 0.000001 | 0 | PASS |

Scope: this covers uncompressed scalar 3D NIfTI-1 affine ingestion through qform/sform metadata, spatial unit conversion to millimeters, and voxel-to-world mapping for committed synthetic fixtures. It also covers local DICOM stack sorting, IOP/IPP/PixelSpacing patient-space mapping, enhanced multi-frame per-frame geometry and pixel-value transformations, and fail-closed flags for duplicate IPP or mixed FrameOfReferenceUID fixtures.

Not covered yet: NIfTI-2 or signed 8-bit/unsigned 32-bit numerical parity against an external oracle, NIfTI scalar dim-4 numerical parity against nibabel beyond synthetic import-contract tests, compressed `.nii.gz` numerical parity against an external oracle, compressed DICOM pixel codecs, derived-object registration, microscopy geometry, rendering, measurement UI, or any clinical/diagnostic use.
